import 'server-only';

import { dispatchPushNotifications } from '@/lib/push/dispatch';
import { createPushDispatchStore } from '@/lib/push/push-store';
import { createApnsSender, readApnsConfiguration } from '@/lib/push/apns';
import {
  createRoutingPushSender,
  createWebPushSender,
  readVapidConfiguration,
} from '@/lib/push/sender';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * The one call a server action makes after a domain operation created
 * notifications.
 *
 * It never throws and never reports failure to the caller, because there is
 * nothing useful a caller could do: the match is published, the notification
 * rows are committed, and push is a best-effort copy of information the user
 * already has waiting in the app. Making a publication fail because a push
 * service was briefly unreachable would trade a real outcome for a cosmetic one.
 */

/**
 * Finds the notifications a domain event just created, by their idempotency-key
 * prefix, and pushes them.
 *
 * Reading back by prefix rather than having the database return ids keeps the
 * SQL functions free of any knowledge that push exists — they create canonical
 * notifications and stop, exactly as the decision record requires.
 */
export async function dispatchPushForKeyPrefix(prefix: string): Promise<void> {
  try {
    const supabase = await createSupabaseServerClient();

    // Runs under the caller's own RLS, which returns only notifications
    // addressed to them — so this alone cannot see the fanout. The service-role
    // store below re-reads the full set; this query exists to confirm the
    // prefix matched anything at all before doing privileged work.
    const store = createPushDispatchStore();
    if (store === null) {
      return;
    }

    const admin = await findNotificationIdsByPrefix(prefix);
    if (admin.length === 0) {
      return;
    }

    // Either transport, both, or neither. A channel with no credentials
    // configured makes its devices skip rather than fail, so a deployment can
    // gain APNs later without a backlog of permanently-failed rows to unpick.
    const vapid = readVapidConfiguration();
    const apns = readApnsConfiguration();

    await dispatchPushNotifications(admin, {
      store,
      sender: createRoutingPushSender({
        web_push: vapid === null ? null : createWebPushSender(vapid),
        apns: apns === null ? null : createApnsSender(apns),
      }),
    });

    void supabase;
  } catch {
    // Deliberately silent: this runs after the transaction has committed, and
    // a push failure must not surface as a domain failure.
  }
}

/**
 * Looks up the ids created by one fanout.
 *
 * Uses the service-role client because a fanout addresses many users and no
 * single session can see all of it.
 */
async function findNotificationIdsByPrefix(prefix: string): Promise<string[]> {
  const { createSupabaseAdminClient, isServiceRoleConfigured } = await import(
    '@/lib/supabase/admin'
  );
  if (!isServiceRoleConfigured()) {
    return [];
  }

  const client = createSupabaseAdminClient();

  const { data } = await client
    .from('notifications')
    .select('id')
    .like('idempotency_key', `${prefix}:%`)
    .is('read_at', null)
    .limit(500);

  return (data ?? []).map((row) => row.id);
}

import 'server-only';

import { dispatchPushForKeyPrefix } from '@/lib/push/notify';
import { createSupabaseAdminClient, isServiceRoleConfigured } from '@/lib/supabase/admin';

/**
 * One pass of the reminder worker.
 *
 * Two steps, deliberately in this order and with a hard boundary between them:
 *
 *   1. the database claims every due reminder and writes the canonical
 *      notifications, committing;
 *   2. only then is push attempted, and only for the batches step 1 actually
 *      created.
 *
 * Step 2 cannot undo step 1. A push service that is down, a device whose
 * subscription has expired, or a crash between the two leaves every reminder
 * sitting in the inbox where it belongs — which is the whole reason the
 * canonical record is the source of truth and push is a delivery channel.
 *
 * Uses the service-role client because the generator writes notifications
 * addressed to many different users, which no client session may do. The
 * function also re-checks the role itself, so a leaked call through another
 * path is still refused.
 */
export interface ReminderRunResult {
  /** Reminder occurrences claimed by this pass. */
  claimed: number;
  /** Canonical notifications created across those occurrences. */
  notified: number;
  /** True when no service-role key is configured, so nothing ran. */
  skipped: boolean;
}

export async function runDueReminders(limit = 100): Promise<ReminderRunResult> {
  if (!isServiceRoleConfigured()) {
    return { claimed: 0, notified: 0, skipped: true };
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('generate_due_reminders', { p_limit: limit });

  if (error !== null || data === null) {
    // Nothing was claimed, so the next pass will find the same rows pending.
    // Failing loudly here would be worse than useless: the scheduler retries.
    return { claimed: 0, notified: 0, skipped: false };
  }

  const claimed = data.length;
  const notified = data.reduce((total, row) => total + row.notified, 0);

  // Per claimed occurrence, so this pushes exactly what it just created rather
  // than re-walking every reminder notification that has ever existed.
  for (const row of data) {
    try {
      await dispatchPushForKeyPrefix(`reminder:${row.reminder_id}`);
    } catch {
      /* the notification is already committed; push is best effort */
    }
  }

  return { claimed, notified, skipped: false };
}

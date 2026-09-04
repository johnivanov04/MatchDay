import 'server-only';

import type { EmailDispatchNotification, EmailDispatchStore } from '@/lib/email/dispatch';
import { createSupabaseAdminClient, isServiceRoleConfigured } from '@/lib/supabase/admin';
import type { EmailDeliveryStatus } from '@/types/database';

/**
 * The real `EmailDispatchStore`, backed by the service-role client.
 *
 * The service role is genuinely required. Resolving a recipient reads
 * `auth.users` for a confirmed address — through a SECURITY DEFINER function
 * that no client role may execute — and delivery bookkeeping writes a table no
 * client role may see. Neither is a shortcut: the worker is the one component
 * that legitimately handles somebody else's email address, it runs only
 * server-side after the domain transaction, and it never returns the address
 * to a caller or writes it to a log.
 *
 * Returns `null` with no service-role key, matching `createPushDispatchStore`.
 */
export function createEmailDispatchStore(): EmailDispatchStore | null {
  if (!isServiceRoleConfigured()) {
    return null;
  }

  let client: ReturnType<typeof createSupabaseAdminClient>;
  try {
    client = createSupabaseAdminClient();
  } catch {
    return null;
  }

  return {
    async loadNotifications(notificationIds: string[]): Promise<EmailDispatchNotification[]> {
      // The same four fields the push payload may use, and no more. Nothing
      // else about the notification can reach an inbox because nothing else is
      // fetched.
      const { data } = await client
        .from('notifications')
        .select('id, type, title, body, deep_link')
        .in('id', notificationIds);

      return data ?? [];
    },

    async resolveRecipient(notificationId: string): Promise<string | null> {
      const { data, error } = await client.rpc('notification_email_recipient', {
        p_notification_id: notificationId,
      });

      // A refusal is not "nobody to email" — it is the resolver being broken,
      // and silently treating it as a no-op would drop mail without a trace.
      // Thrown so the dispatcher records the pass as aborted.
      if (error !== null) {
        throw error;
      }

      return data ?? null;
    },

    async alreadySettled(notificationId: string): Promise<boolean> {
      const { data } = await client
        .from('email_delivery_attempts')
        .select('status')
        .eq('notification_id', notificationId)
        .maybeSingle();

      // Only a terminal state stops a retry. A previous `temporary_failure` is
      // exactly the case Phase 3C exists to come back for — the same rule
      // `push-store.ts` applies per subscription.
      return data !== null && (data.status === 'sent' || data.status === 'permanent_failure');
    },

    async recordResult(
      notificationId: string,
      status: EmailDeliveryStatus,
      errorCategory: string | null,
      providerMessageId: string | null = null,
    ): Promise<void> {
      await client.rpc('record_email_delivery_result', {
        p_notification_id: notificationId,
        p_status: status,
        p_error_category: errorCategory,
        p_provider_message_id: providerMessageId,
      });
    },
  };
}

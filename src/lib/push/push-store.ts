import 'server-only';

import type { CanonicalNotificationForPush } from '@/lib/push/payload';
import type { PushDispatchStore, PushSubscriptionRecord } from '@/lib/push/dispatch';
import { createSupabaseAdminClient, isServiceRoleConfigured } from '@/lib/supabase/admin';
import type { ApnsEnvironment, PushChannel, PushDeliveryStatus } from '@/types/database';

/**
 * The real `PushDispatchStore`, backed by the service-role client.
 *
 * The service role is genuinely required here and is not a shortcut. Delivery
 * has to read *other people's* subscription credentials in order to send them
 * anything, and those columns are granted to no client role at all — the
 * dispatcher is the one component in the system that legitimately sees them. It
 * runs only in server-side code, after the domain transaction has committed,
 * and never returns a credential to a caller.
 *
 * Returns `null` when no service-role key is configured, which makes push
 * degrade to "in-app only" rather than crash. The canonical notifications are
 * already committed by the time anything here runs.
 */
export function createPushDispatchStore(): PushDispatchStore | null {
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
    async loadNotifications(notificationIds: string[]): Promise<CanonicalNotificationForPush[]> {
      // Only the four fields a payload may contain are selected. Nothing else
      // about the notification can reach a lock screen because nothing else is
      // fetched.
      const { data } = await client
        .from('notifications')
        .select('id, type, title, body, deep_link')
        .in('id', notificationIds);

      return data ?? [];
    },

    async loadRecipients(notificationIds: string[]): Promise<Map<string, string>> {
      const { data } = await client
        .from('notifications')
        .select('id, recipient_user_id')
        .in('id', notificationIds);

      return new Map((data ?? []).map((row) => [row.id, row.recipient_user_id]));
    },

    async loadEnabledSubscriptions(userIds: string[]): Promise<PushSubscriptionRecord[]> {
      if (userIds.length === 0) {
        return [];
      }

      // Both address shapes, selected together and separated by `channel` on
      // the way out. The credential columns — `endpoint`, `p256dh`,
      // `auth_secret`, `device_token` — are granted to no client role at all,
      // which is why this is the service-role client and why the result never
      // leaves the dispatcher.
      const { data } = await client
        .from('push_subscriptions')
        .select(
          'id, user_id, channel, endpoint, p256dh, auth_secret, device_token, apns_environment',
        )
        .in('user_id', userIds)
        .eq('enabled', true);

      const rows = (data ?? []) as unknown as Array<{
        id: string;
        user_id: string;
        channel: PushChannel;
        endpoint: string | null;
        p256dh: string | null;
        auth_secret: string | null;
        device_token: string | null;
        apns_environment: ApnsEnvironment | null;
      }>;

      // Narrowed rather than cast. `push_subscriptions_channel_shape` already
      // guarantees each row is fully one shape or the other, so a row failing
      // these checks is a row the dispatcher genuinely cannot address — and
      // dropping it is better than sending `undefined` to a push service.
      return rows.flatMap((row): PushSubscriptionRecord[] => {
        if (row.channel === 'apns') {
          return row.device_token !== null && row.apns_environment !== null
            ? [
                {
                  id: row.id,
                  user_id: row.user_id,
                  channel: 'apns',
                  device_token: row.device_token,
                  apns_environment: row.apns_environment,
                },
              ]
            : [];
        }

        return row.endpoint !== null && row.p256dh !== null && row.auth_secret !== null
          ? [
              {
                id: row.id,
                user_id: row.user_id,
                channel: 'web_push',
                endpoint: row.endpoint,
                p256dh: row.p256dh,
                auth_secret: row.auth_secret,
              },
            ]
          : [];
      });
    },

    async alreadyDelivered(notificationId: string, subscriptionId: string): Promise<boolean> {
      const { data } = await client
        .from('push_delivery_attempts')
        .select('status')
        .eq('notification_id', notificationId)
        .eq('subscription_id', subscriptionId)
        .maybeSingle();

      // Only a terminal state stops a retry. A previous temporary failure is
      // exactly the case worth trying again.
      return (
        data !== null &&
        (data.status === 'sent' ||
          data.status === 'permanent_failure' ||
          data.status === 'invalidated')
      );
    },

    async recordResult(
      notificationId: string,
      subscriptionId: string,
      status: PushDeliveryStatus,
      errorCategory: string | null,
    ): Promise<void> {
      await client.rpc('record_push_delivery_result', {
        p_notification_id: notificationId,
        p_subscription_id: subscriptionId,
        p_status: status,
        p_error_category: errorCategory,
      });
    },
  };
}

import 'server-only';

import { classifyPushError, classifyPushStatusCode } from '@/lib/push/classify';
import { buildPushPayload, type CanonicalNotificationForPush } from '@/lib/push/payload';
import type { PushSender, PushTarget } from '@/lib/push/sender';
import type { PushDeliveryStatus } from '@/types/database';

/**
 * Delivering canonical notifications to phones.
 *
 * Two rules shape everything here.
 *
 * **Push never fails the domain operation.** By the time this runs, the match
 * is published and the notification rows are committed. A push service being
 * down, a VAPID key being unset, a dead endpoint — none of that may roll back a
 * publication or lose an in-app notification. Every failure is caught, recorded
 * as a category, and swallowed.
 *
 * **Delivery is idempotent per (notification, subscription).** The unique index
 * on `push_delivery_attempts` is the guarantee; re-running a dispatch cannot
 * put the same alert on the same phone twice.
 *
 * The store and the sender are both injected, so the whole flow is testable
 * without a network or a database.
 */

export interface PushSubscriptionRecord {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth_secret: string;
}

/**
 * The persistence this dispatcher needs. Implemented against the service-role
 * client in `push-store.ts`, and against plain objects in tests.
 */
export interface PushDispatchStore {
  /** Canonical notifications by id, with only the fields a payload may use. */
  loadNotifications(notificationIds: string[]): Promise<CanonicalNotificationForPush[]>;
  /** Recipient of each notification. Kept separate so the payload shape stays narrow. */
  loadRecipients(notificationIds: string[]): Promise<Map<string, string>>;
  /** Enabled subscriptions for these users. */
  loadEnabledSubscriptions(userIds: string[]): Promise<PushSubscriptionRecord[]>;
  /** True when this pair has already reached a terminal state. */
  alreadyDelivered(notificationId: string, subscriptionId: string): Promise<boolean>;
  recordResult(
    notificationId: string,
    subscriptionId: string,
    status: PushDeliveryStatus,
    errorCategory: string | null,
  ): Promise<void>;
}

export interface PushDispatchResult {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * Sends every eligible notification in `notificationIds` to every enabled
 * device of its recipient.
 *
 * Never throws. The worst outcome is a result object reporting that nothing was
 * sent.
 */
export async function dispatchPushNotifications(
  notificationIds: string[],
  deps: { store: PushDispatchStore; sender: PushSender | null },
): Promise<PushDispatchResult> {
  const result: PushDispatchResult = { attempted: 0, sent: 0, failed: 0, skipped: 0 };

  if (notificationIds.length === 0) {
    return result;
  }

  // No VAPID configuration: push is simply not available on this deployment.
  // The canonical notifications already exist, so nothing is lost.
  if (deps.sender === null) {
    result.skipped = notificationIds.length;
    return result;
  }

  try {
    const notifications = await deps.store.loadNotifications(notificationIds);
    if (notifications.length === 0) {
      return result;
    }

    const recipients = await deps.store.loadRecipients(notificationIds);
    const userIds = [...new Set([...recipients.values()])];
    const subscriptions = await deps.store.loadEnabledSubscriptions(userIds);

    const subscriptionsByUser = new Map<string, PushSubscriptionRecord[]>();
    for (const subscription of subscriptions) {
      const existing = subscriptionsByUser.get(subscription.user_id) ?? [];
      existing.push(subscription);
      subscriptionsByUser.set(subscription.user_id, existing);
    }

    for (const notification of notifications) {
      const payload = buildPushPayload(notification);

      // Not push-eligible, or an unsafe deep link. Either way the in-app
      // notification stands and this one is simply not pushed.
      if (payload === null) {
        result.skipped += 1;
        continue;
      }

      const recipient = recipients.get(notification.id);
      if (recipient === undefined) {
        result.skipped += 1;
        continue;
      }

      for (const subscription of subscriptionsByUser.get(recipient) ?? []) {
        // The database's unique index is the real guarantee; this check just
        // avoids a pointless network round trip on a re-run.
        if (await deps.store.alreadyDelivered(notification.id, subscription.id)) {
          result.skipped += 1;
          continue;
        }

        const target: PushTarget = {
          subscriptionId: subscription.id,
          endpoint: subscription.endpoint,
          p256dh: subscription.p256dh,
          auth: subscription.auth_secret,
        };

        result.attempted += 1;

        const outcome = await deps.sender.send(target, payload);

        if (outcome.ok) {
          await deps.store.recordResult(notification.id, subscription.id, 'sent', null);
          result.sent += 1;
          continue;
        }

        const classification =
          'statusCode' in outcome
            ? classifyPushStatusCode(outcome.statusCode)
            : classifyPushError(outcome.error);

        await deps.store.recordResult(
          notification.id,
          subscription.id,
          classification.status,
          classification.category,
        );
        result.failed += 1;
      }
    }
  } catch {
    // Deliberately swallowed, and deliberately not logged with the error
    // object: a failure here can carry endpoints and provider responses, and
    // this path runs after the domain transaction has already committed.
    return result;
  }

  return result;
}

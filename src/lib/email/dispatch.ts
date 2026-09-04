import 'server-only';

import { classifyEmailError, classifyEmailStatusCode } from '@/lib/email/classify';
import { emailIdempotencyKey, type EmailSender } from '@/lib/email/resend';
import { absoluteAppUrl, renderNotificationEmail } from '@/lib/email/template';
import { isPushEligible } from '@/lib/push/payload';
import type { EmailDeliveryStatus, NotificationType } from '@/types/database';

/**
 * The email channel, shaped exactly like the push one.
 *
 * `dispatchEmailNotifications` returns the same counts
 * `dispatchPushNotifications` does, so the delivery worker can add the two
 * results together and hand the total to Phase 3C's existing decision logic
 * without knowing how many channels there were.
 *
 * ── ELIGIBILITY IS SHARED, NOT DUPLICATED ──────────────────────────────────
 *
 * A notification worth interrupting somebody's evening for is a notification
 * worth an email; one that is not, is not. So `isPushEligible` is the authority
 * for both channels rather than a second list that would drift — which is
 * exactly how `attendance_recorded` stays out of an inbox as well as off a lock
 * screen. Phase 3E is where the two lists legitimately diverge, per type and
 * per channel, and it will replace this call rather than work around it.
 */

export interface EmailDispatchNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  deep_link: string;
}

export interface EmailDispatchStore {
  loadNotifications(notificationIds: string[]): Promise<EmailDispatchNotification[]>;
  /**
   * The address this notification should go to, or `null` for "nobody".
   *
   * Every gate lives in SQL: the global switch, a confirmed address, a live
   * account. `null` is a legitimate no-op and never an error.
   */
  resolveRecipient(notificationId: string): Promise<string | null>;
  /** True when this notification's email already reached a terminal state. */
  alreadySettled(notificationId: string): Promise<boolean>;
  recordResult(
    notificationId: string,
    status: EmailDeliveryStatus,
    errorCategory: string | null,
    providerMessageId?: string | null,
  ): Promise<void>;
}

export interface EmailDispatchResult {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  retryable: number;
  aborted: boolean;
}

export interface EmailDispatchDeps {
  store: EmailDispatchStore;
  sender: EmailSender | null;
  /** Absolute origin for links. Production passes the deployment's own site URL. */
  baseUrl: string;
}

/**
 * Sends every eligible notification in `notificationIds` to its recipient's
 * account address.
 *
 * Never throws. Reports an incomplete pass through `aborted`, the same
 * distinction Phase 3B added to push dispatch so that "nothing to do" and
 * "could not do it" stop looking identical.
 */
export async function dispatchEmailNotifications(
  notificationIds: string[],
  deps: EmailDispatchDeps,
): Promise<EmailDispatchResult> {
  const result: EmailDispatchResult = {
    attempted: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    retryable: 0,
    aborted: false,
  };

  if (notificationIds.length === 0) {
    return result;
  }

  // No transport: this deployment has no email configured. Nothing attempted,
  // nothing recorded, and adding `RESEND_API_KEY` later leaves no terminal rows
  // behind to unpick.
  if (deps.sender === null) {
    result.skipped = notificationIds.length;
    return result;
  }

  try {
    const notifications = await deps.store.loadNotifications(notificationIds);

    for (const notification of notifications) {
      // Not worth an email at all — the same set push consults.
      if (!isPushEligible(notification.type)) {
        result.skipped += 1;
        continue;
      }

      // Already delivered, or already permanently refused. This is what stops a
      // Phase 3C retry — scheduled because a *push* was rate limited — from
      // sending a second copy of an email that already arrived.
      if (await deps.store.alreadySettled(notification.id)) {
        result.skipped += 1;
        continue;
      }

      const recipient = await deps.store.resolveRecipient(notification.id);

      // Switched off, unverified, deleted, or gone. A legitimate no-op: no
      // attempt row, no provider call, and crucially no retry work, because
      // waiting does not conjure a confirmed address.
      if (recipient === null) {
        result.skipped += 1;
        continue;
      }

      const url = absoluteAppUrl(deps.baseUrl, notification.deep_link);
      const settingsUrl = absoluteAppUrl(deps.baseUrl, '/settings/notifications');

      // A malformed deep link is this notification's problem and nobody else's.
      // Recorded permanently rather than retried: the column will not heal.
      if (url === null || settingsUrl === null) {
        await deps.store.recordResult(notification.id, 'permanent_failure', 'invalid_link', null);
        result.attempted += 1;
        result.failed += 1;
        continue;
      }

      const rendered = renderNotificationEmail({
        title: notification.title,
        body: notification.body,
        url,
        settingsUrl,
      });

      const outcome = await deps.sender.send({
        to: recipient,
        rendered,
        idempotencyKey: emailIdempotencyKey(notification.id),
      });

      if (!outcome.ok && 'unsupported' in outcome) {
        result.skipped += 1;
        continue;
      }

      result.attempted += 1;

      if (outcome.ok) {
        await deps.store.recordResult(
          notification.id,
          'sent',
          null,
          outcome.providerMessageId ?? null,
        );
        result.sent += 1;
        continue;
      }

      const classification =
        'statusCode' in outcome
          ? classifyEmailStatusCode(outcome.statusCode)
          : classifyEmailError(outcome.error);

      await deps.store.recordResult(
        notification.id,
        classification.status,
        classification.category,
        null,
      );
      result.failed += 1;

      if (classification.status === 'temporary_failure') {
        result.retryable += 1;
      }
    }
  } catch {
    // Deliberately swallowed and deliberately not logged with the error object:
    // a failure here can carry the recipient address and the provider response.
    result.aborted = true;
    return result;
  }

  return result;
}

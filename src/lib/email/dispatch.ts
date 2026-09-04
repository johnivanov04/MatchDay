import 'server-only';

import { createHash } from 'node:crypto';
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
  /**
   * What we already know about this notification's email.
   *
   * One read rather than two: the dispatcher needs both whether the channel is
   * finished and what payload was last sent under this idempotency key.
   */
  loadAttempt(notificationId: string): Promise<EmailAttemptState | null>;
  recordResult(
    notificationId: string,
    status: EmailDeliveryStatus,
    errorCategory: string | null,
    providerMessageId?: string | null,
    payloadFingerprint?: string | null,
  ): Promise<void>;
}

export interface EmailAttemptState {
  /** Terminal — `sent` or `permanent_failure`. Nothing more is owed. */
  settled: boolean;
  /** SHA-256 of the request sent on the first real provider call, if any. */
  payloadFingerprint: string | null;
}

/**
 * A stable fingerprint of exactly what Resend is being asked to send.
 *
 * Canonicalised by construction — a fixed field order and an explicit
 * separator, never `JSON.stringify` of an object whose key order is an
 * implementation detail. The separator is a control character that cannot
 * occur in any of the fields, so no combination of values can be made to
 * collide by moving a boundary.
 */
export function payloadFingerprint(input: {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}): string {
  const canonical = [input.from, input.to, input.subject, input.html, input.text].join('\u0000');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
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
  /**
   * The configured from-address, needed to fingerprint the request.
   *
   * Passed in rather than read here so the dispatcher stays free of
   * configuration, and so a test can change it between two passes — which is
   * exactly the drift this fingerprint exists to catch.
   */
  from: string;
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

      const attempt = await deps.store.loadAttempt(notification.id);

      // Already delivered, or already permanently refused. This is what stops a
      // Phase 3C retry — scheduled because a *push* was rate limited — from
      // sending a second copy of an email that already arrived.
      if (attempt?.settled === true) {
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

      // ── THE IDEMPOTENCY KEY AND THE PAYLOAD MUST AGREE ───────────────────
      //
      // Resend suppresses a duplicate only when the key AND the payload match;
      // the same key with a changed payload is a 409 `invalid_idempotent_request`.
      // Our key is stable by construction, but the payload is not: `to` is
      // resolved from `auth.users` on every pass, and somebody can confirm a
      // new address between the first attempt and the retry. `from` and the
      // link base are operator-settable too.
      //
      // Minting a new key for the new address would be worse. If the original
      // request actually reached Resend and only our response was lost, a fresh
      // key is a second email — and a duplicate email is permanent, searchable
      // and forwardable in a way a duplicate push is not.
      //
      // So a changed payload ends the channel, visibly, rather than guessing.
      const fingerprint = payloadFingerprint({
        from: deps.from,
        to: recipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });

      if (attempt?.payloadFingerprint != null && attempt.payloadFingerprint !== fingerprint) {
        await deps.store.recordResult(
          notification.id,
          'permanent_failure',
          'idempotency_payload_changed',
          null,
          null,
        );
        result.attempted += 1;
        result.failed += 1;
        continue;
      }

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
          fingerprint,
        );
        result.sent += 1;
        continue;
      }

      const classification =
        'statusCode' in outcome
          ? classifyEmailStatusCode(outcome.statusCode, outcome.providerErrorName ?? null)
          : classifyEmailError(outcome.error);

      // The fingerprint is recorded on a failure too, and the RPC keeps the
      // FIRST one. A request that reached Resend and was rate limited still
      // consumed the idempotency key for that payload.
      await deps.store.recordResult(
        notification.id,
        classification.status,
        classification.category,
        null,
        fingerprint,
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

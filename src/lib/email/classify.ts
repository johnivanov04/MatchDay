/**
 * What a provider's answer means for the delivery job.
 *
 * The vocabulary is deliberately the one Phase 3C already speaks — `sent`,
 * `temporary_failure`, `permanent_failure` — so that a queue job with a push
 * channel and an email channel can be reasoned about with a single rule rather
 * than two parallel state machines that drift.
 *
 * `invalidated` has no email analogue and is absent: there is no subscription to
 * retire, only an account address that either works or does not.
 */

import type { EmailDeliveryStatus } from '@/types/database';

export interface EmailFailureClassification {
  status: Exclude<EmailDeliveryStatus, 'pending' | 'sent'>;
  /** Lower-snake, ≤40 chars — the shape the database constraint enforces. */
  category: string;
}

/**
 * HTTP status from the provider.
 *
 * The split is the same judgement push makes: anything that could plausibly
 * succeed on a later attempt is temporary, and anything that will produce an
 * identical refusal forever is permanent. Retrying a malformed request or a bad
 * API key five times just makes the same mistake on a schedule.
 */
export function classifyEmailStatusCode(
  statusCode: number,
  /**
   * Resend's own error name, when the response carried one.
   *
   * Two 409s mean opposite things and the HTTP status alone cannot tell them
   * apart, so the structured name is consulted first wherever it exists.
   */
  providerErrorName?: string | null,
): EmailFailureClassification {
  // ── THE TWO 409s ─────────────────────────────────────────────────────────
  //
  // Resend de-duplicates on (idempotency key AND identical payload), and
  // answers 409 in two completely different situations:
  //
  //   • `concurrent_idempotent_requests` — another request with this key is
  //     still in flight. Nothing is wrong; we simply arrived while a previous
  //     attempt was being processed. RETRYABLE, and the 3C ladder is exactly
  //     the right way to come back — a busy-loop would just hammer Resend with
  //     the same collision.
  //
  //   • `invalid_idempotent_request` — this key was already used with a
  //     DIFFERENT payload. That is our bug, not Resend's, and retrying sends
  //     the same contradiction again. PERMANENT and operator-visible.
  //
  // Treating both as permanent — which a bare status check does — silently
  // drops a message that would have gone out a minute later.
  if (providerErrorName === 'concurrent_idempotent_requests') {
    return { status: 'temporary_failure', category: 'concurrent_request' };
  }

  if (providerErrorName === 'invalid_idempotent_request') {
    return { status: 'permanent_failure', category: 'idempotency_mismatch' };
  }

  // A malformed key is a request we built wrong. No amount of waiting fixes it.
  if (providerErrorName === 'invalid_idempotency_key') {
    return { status: 'permanent_failure', category: 'invalid_idempotency_key' };
  }

  // Rate limited. The single most retry-worthy answer a provider gives.
  if (statusCode === 429) {
    return { status: 'temporary_failure', category: 'rate_limited' };
  }

  // The provider is having a bad time. Ours to wait out, not to fix.
  if (statusCode >= 500) {
    return { status: 'temporary_failure', category: 'server_error' };
  }

  // OPERATOR-WORTHY, AND NOT RETRYABLE. A missing, revoked or wrong API key,
  // or a sending domain that was never verified. Every retry burns the budget
  // to be told the same thing, and the fix is a person changing configuration.
  if (statusCode === 401 || statusCode === 403) {
    return { status: 'permanent_failure', category: 'unauthorized' };
  }

  // We built the request wrong, or the address is not one the provider will
  // ever accept. Both are permanent for this notification.
  if (statusCode === 400 || statusCode === 422) {
    return { status: 'permanent_failure', category: 'invalid_request' };
  }

  if (statusCode === 404) {
    return { status: 'permanent_failure', category: 'not_found' };
  }

  // A 409 whose name we did not recognise. Conservatively retryable: an
  // unnamed conflict is more likely to be the concurrent case than a payload
  // mismatch, and one wasted retry costs less than a dropped notification.
  if (statusCode === 409) {
    return { status: 'temporary_failure', category: 'conflict' };
  }

  if (statusCode === 413) {
    return { status: 'permanent_failure', category: 'payload_too_large' };
  }

  // Any other 4xx. Client-side by definition, so retrying is not the answer.
  if (statusCode >= 400) {
    return { status: 'permanent_failure', category: 'rejected' };
  }

  // A 3xx or an unexpected 2xx that was not treated as success upstream.
  // Unknown rather than assumed permanent: the cost of one wasted retry is
  // lower than the cost of silently dropping a deliverable notification.
  return { status: 'temporary_failure', category: 'unknown' };
}

/**
 * A throw from the transport — no HTTP response was ever seen.
 *
 * All retryable. Nothing here says the message was refused; it says we never
 * managed to ask.
 */
export function classifyEmailError(error: unknown): EmailFailureClassification {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : '';

  if (name === 'AbortError' || name === 'TimeoutError') {
    return { status: 'temporary_failure', category: 'timeout' };
  }

  return { status: 'temporary_failure', category: 'network' };
}

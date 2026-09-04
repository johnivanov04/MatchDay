import 'server-only';

import { classifyEmailError, classifyEmailStatusCode } from '@/lib/email/classify';
import type { RenderedEmail } from '@/lib/email/template';

/**
 * Resend, over its HTTPS API.
 *
 * No SMTP: there is no SMTP infrastructure in this product to reuse, and a
 * long-lived socket is the wrong shape for a function that may be frozen
 * between two sends. One POST, one answer, no connection to keep warm.
 *
 * ── THE SEND OUTCOME IS THE SAME VOCABULARY AS PUSH ────────────────────────
 *
 * `EmailSendOutcome` mirrors `PushSendOutcome` deliberately, down to
 * `unsupported` meaning "this deployment has no transport" rather than "this
 * send failed". A deployment with no `RESEND_API_KEY` skips email exactly as
 * one with no VAPID keys skips Web Push: nothing attempted, nothing recorded,
 * no rows to unpick when the credentials arrive.
 */

export interface EmailConfiguration {
  apiKey: string;
  /** RFC 5322 from-address. Its domain must be verified with the provider. */
  from: string;
}

export type EmailSendOutcome =
  | { ok: true; providerMessageId?: string }
  | { ok: false; unsupported: true }
  | { ok: false; statusCode: number }
  | { ok: false; error: unknown };

export interface EmailMessage {
  to: string;
  rendered: RenderedEmail;
  /**
   * Deterministic per notification. See `emailIdempotencyKey`.
   */
  idempotencyKey: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<EmailSendOutcome>;
}

/** Injected in tests so nothing here ever reaches the real provider. */
export interface EmailTransport {
  post(request: {
    url: string;
    apiKey: string;
    idempotencyKey: string;
    body: unknown;
  }): Promise<{ status: number; json: unknown }>;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The key that makes a retry safe on the provider's side.
 *
 * ── WHY THIS MATTERS MORE THAN IT LOOKS ────────────────────────────────────
 *
 * The queue is at-least-once. A worker can be killed after Resend has accepted
 * a message and before MatchDay records that it did, and the next pass will
 * send again. With push that is survivable — a duplicate lock-screen alert is
 * annoying. A duplicate email is worse: it lands in a permanent, searchable,
 * forwardable record and looks like a bug in the product.
 *
 * Resend de-duplicates on this header for 24 hours, so a repeat inside that
 * window is accepted and not re-delivered.
 *
 * ── WHAT IS IN IT, AND WHAT IS NOT ─────────────────────────────────────────
 *
 * The notification id and nothing else. It is already a UUID the recipient
 * cannot influence, it is stable across every retry of the same notification,
 * and it is unique per (recipient, event) because a fanout writes one
 * notification row per person.
 *
 * No email address — the key travels in a header to a third party and is echoed
 * in their dashboards and logs; putting somebody's address in it would leak PII
 * for no gain. No user id, no device information, no secret. The `v1` suffix is
 * the escape hatch: if the message content ever changes in a way that should
 * legitimately re-send, the version moves and the old key stops matching.
 *
 * This materially reduces duplicate risk. It does NOT make delivery
 * exactly-once — see `docs/operations/production.md`.
 */
export function emailIdempotencyKey(notificationId: string): string {
  return `matchday/notification/${notificationId}/email/v1`;
}

/**
 * Reads the provider configuration, or `null` when email is not set up.
 *
 * Never throws and is never called at module load, so a deployment without an
 * API key starts, serves and delivers push exactly as before. Email is the only
 * thing that is missing, and it is missing quietly.
 */
export function readEmailConfiguration(): EmailConfiguration | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();

  if (apiKey === undefined || apiKey === '' || from === undefined || from === '') {
    return null;
  }

  return { apiKey, from };
}

/** `fetch` against Resend, with a bounded timeout. */
export function createResendTransport(): EmailTransport {
  return {
    async post({ url, apiKey, idempotencyKey, body }) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          // Resend's own de-duplication window.
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: 'no-store',
      });

      // Parsed defensively: an error response is not guaranteed to be JSON, and
      // a body we cannot read must not turn a classified failure into a throw.
      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }

      return { status: response.status, json };
    },
  };
}

/** Pulls Resend's message id out of a success body, if it is there. */
function providerMessageIdFrom(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null || !('id' in json)) {
    return undefined;
  }
  const id = (json as { id: unknown }).id;
  // The column's shape constraint refuses anything else, so a provider that
  // changes its identifier format degrades to "no id recorded" rather than
  // failing the whole delivery.
  return typeof id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : undefined;
}

export function createResendSender(
  config: EmailConfiguration,
  transport: EmailTransport = createResendTransport(),
): EmailSender {
  return {
    async send(message: EmailMessage): Promise<EmailSendOutcome> {
      try {
        const { status, json } = await transport.post({
          url: RESEND_ENDPOINT,
          apiKey: config.apiKey,
          idempotencyKey: message.idempotencyKey,
          body: {
            from: config.from,
            to: [message.to],
            subject: message.rendered.subject,
            html: message.rendered.html,
            text: message.rendered.text,
          },
        });

        if (status >= 200 && status < 300) {
          const id = providerMessageIdFrom(json);
          return id === undefined ? { ok: true } : { ok: true, providerMessageId: id };
        }

        // The status only. A Resend error body can quote the recipient address
        // and the message subject, and neither belongs in anything a caller
        // might log.
        return { ok: false, statusCode: status };
      } catch (error: unknown) {
        // Handed on unmodified for `classifyEmailError` to inspect
        // structurally, and never logged: a fetch error can carry the request
        // URL and headers.
        return { ok: false, error };
      }
    },
  };
}

/** Re-exported so the dispatcher classifies without importing two modules. */
export { classifyEmailStatusCode, classifyEmailError };

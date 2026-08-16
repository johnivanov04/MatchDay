import 'server-only';

import { logInfo, logWarn } from '@/lib/observability/log';

/**
 * External heartbeat signalling for the reminder scheduler.
 *
 * ── WHAT THIS SOLVES ───────────────────────────────────────────────────────
 *
 * `reminder.run` is emitted on every pass, including empty ones, precisely so
 * that its *absence* means the scheduler has stopped. But absence is only a
 * signal if something is watching for it, and nothing in this repository can
 * watch itself: if the deployment stops running crons, it also stops being able
 * to notice. That needs an outside observer, which is what a Better Stack
 * heartbeat is — it alarms when the expected ping does not arrive.
 *
 * ── HEARTBEAT DELIVERY IS NEVER PART OF REMINDER CORRECTNESS ───────────────
 *
 * Nothing here throws. A monitoring provider being down must not turn a
 * successful reminder run into a failed cron response, and must not mask the
 * original error when the run genuinely failed. Every failure is caught,
 * classified, logged, and swallowed — the same discipline the push pipeline
 * follows for the same reason.
 *
 * ── WHAT IS SENT ───────────────────────────────────────────────────────────
 *
 * A bare GET with **no body, no query string and no headers of our own**. That
 * is not laziness: it is the guarantee. There is no payload to review for PII,
 * no reminder contents, no email address, no subscription data, and no internal
 * error text, because there is no payload at all. Better Stack needs only the
 * arrival of the request.
 *
 * ── THE URL IS A CREDENTIAL ────────────────────────────────────────────────
 *
 * The heartbeat URL embeds a secret token — anyone holding it can report this
 * job as healthy. It is therefore read only here, never returned to a caller,
 * and never logged. `src/lib/observability/log.ts` would drop a `url` value
 * only if the key matched its denylist, so this module simply never passes one.
 */

/**
 * Deliberately short.
 *
 * The cron response waits on this, so a monitoring outage would otherwise stall
 * a job that had already done its real work. Three seconds is generous for a
 * single unauthenticated GET and negligible against a ten-minute cadence.
 *
 * The call cannot be fire-and-forget: on a serverless platform the function may
 * be frozen the moment the response is returned, so an un-awaited request is
 * not reliably sent at all.
 */
const HEARTBEAT_TIMEOUT_MS = 3_000;

export type HeartbeatKind = 'success' | 'failure';

export type HeartbeatOutcome =
  /** The provider accepted the ping. */
  | 'sent'
  /** No URL configured — expected locally, in tests, and on Preview. */
  | 'not_configured'
  /** Configured but unusable; treated as absent rather than guessed at. */
  | 'invalid_url'
  /** Reached the provider, which answered non-2xx. */
  | 'http_error'
  /** Did not answer within `HEARTBEAT_TIMEOUT_MS`. */
  | 'timeout'
  /** DNS, TLS, connection refused, and anything else transport-level. */
  | 'network_error';

/**
 * Reads the configured heartbeat URL.
 *
 * Read here rather than in `@/lib/env` because that module is reachable from
 * client components — this value never should be. The same reasoning puts
 * `readVapidConfiguration()` inside the server-only sender module.
 *
 * ABSENT AND MISCONFIGURED ARE DIFFERENT ANSWERS, and collapsing them would
 * repeat a bug this codebase has already been bitten by. Unset is the normal
 * state locally, in tests and on Preview. A *mistyped* URL in production means
 * the monitoring is silently off while everything looks fine — the operator
 * must be able to tell those apart in the logs, so `invalid` is warned about
 * and `absent` is not.
 *
 * Neither throws: a bad monitoring URL degrades to "unmonitored" and never
 * takes the reminder cron down with it.
 */
type HeartbeatConfig =
  | { state: 'configured'; url: string }
  | { state: 'absent' }
  | { state: 'invalid' };

function readHeartbeatConfig(): HeartbeatConfig {
  const raw = process.env.REMINDER_HEARTBEAT_URL;
  if (raw === undefined || raw.trim() === '') {
    return { state: 'absent' };
  }

  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { state: 'invalid' };
    }
    return { state: 'configured', url: parsed.toString() };
  } catch {
    return { state: 'invalid' };
  }
}

/**
 * Better Stack's convention: the base URL reports success, and the same URL
 * with `/fail` appended reports a failed run.
 *
 * Trailing slashes are normalised so a URL stored with one does not produce
 * `…//fail`, which the provider would not match to this heartbeat.
 */
function targetFor(baseUrl: string, kind: HeartbeatKind): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return kind === 'failure' ? `${trimmed}/fail` : trimmed;
}

/**
 * Pings the heartbeat. Never throws, never returns the URL.
 *
 * The returned outcome is for tests and for the caller's own logging; the
 * reminder route ignores it, because by design nothing it could say should
 * change the cron's response.
 */
export async function signalHeartbeat(kind: HeartbeatKind): Promise<HeartbeatOutcome> {
  const config = readHeartbeatConfig();

  if (config.state === 'absent') {
    // Not an error. Local development, the test suite and Preview deployments
    // all run without a heartbeat configured, and reminders work fine there.
    logInfo('heartbeat.skipped', { kind, configured: false });
    return 'not_configured';
  }

  if (config.state === 'invalid') {
    // Warned, not merely skipped: in production this means somebody set the
    // variable and the monitoring is silently doing nothing. The value itself
    // is never logged — it is a credential even when malformed.
    logWarn('heartbeat.misconfigured', { kind });
    return 'invalid_url';
  }

  const baseUrl = config.url;

  let response: Response;
  try {
    response = await fetch(targetFor(baseUrl, kind), {
      method: 'GET',
      // No body, no custom headers. See the module header.
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (error: unknown) {
    // `AbortSignal.timeout` rejects with a TimeoutError; everything else is a
    // transport problem. The error object itself is never logged — it can carry
    // the request URL, which is the credential.
    const outcome: HeartbeatOutcome =
      error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network_error';

    logWarn('heartbeat.failed', { kind, outcome });
    return outcome;
  }

  if (!response.ok) {
    // Status code only. The response body could echo the request URL.
    logWarn('heartbeat.failed', { kind, outcome: 'http_error', status: response.status });
    return 'http_error';
  }

  logInfo('heartbeat.sent', { kind });
  return 'sent';
}

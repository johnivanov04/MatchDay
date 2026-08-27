import 'server-only';

import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import type { PushPayload } from '@/lib/push/payload';
import type { PushSendOutcome, PushSender, PushTarget } from '@/lib/push/sender';
import type { ApnsEnvironment } from '@/types/database';

/**
 * Talking to Apple Push Notification service directly.
 *
 * ── WHY NOT A LIBRARY ──────────────────────────────────────────────────────
 *
 * APNs is one HTTP/2 POST carrying a JSON body and six headers, authenticated
 * by a JWT that Node's own crypto can sign. Every published wrapper adds a
 * connection pool, a retry policy and a logger — three things this codebase
 * already has opinions about, and the logger is the dangerous one: a device
 * token is a bearer credential and must never be written anywhere.
 *
 * ── THE PARTS THAT ARE EASY TO GET WRONG ───────────────────────────────────
 *
 *   * **ES256 is not the DER signature `crypto.sign` gives you by default.**
 *     JWS requires the raw `r ‖ s` pair. `dsaEncoding: 'ieee-p1363'` is what
 *     produces it; without it APNs rejects every request as
 *     `InvalidProviderToken` and nothing about the error says why.
 *
 *   * **The provider token must be reused.** Apple requires it to be no more
 *     than an hour old and refuses more than one refresh per twenty minutes
 *     with `TooManyProviderTokenUpdates`. Minting one per notification would
 *     work in testing and fail under a fanout.
 *
 *   * **The environment selects the host.** A token minted against one is
 *     meaningless to the other, and the failure — `BadDeviceToken` — looks
 *     exactly like a corrupt token. See `apns_environment` in
 *     `20260825120100_apns_devices.sql`.
 */

/** Where each environment's notifications are POSTed. */
const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  development: 'api.sandbox.push.apple.com',
  production: 'api.push.apple.com',
};

/**
 * What it takes to talk to APNs, per environment.
 *
 * ── TWO KEYS, NOT ONE ──────────────────────────────────────────────────────
 *
 * Apple's key model is environment-specific, and its current guidance is to
 * hold separate Sandbox and Production keys. Older keys issued before that
 * distinction work in both environments and may continue to — but "may continue
 * to" is not something to build on, and a deployment that assumed one key would
 * discover the assumption on the day the sandbox key stopped being accepted,
 * with the only symptom being that TestFlight testers stopped getting alerts.
 *
 * So each environment carries its own credentials and they are selected by the
 * subscription row's `apns_environment`. An operator holding a legacy
 * dual-environment key configures the same Key ID and the same `.p8` in both
 * pairs, which is a supported configuration and costs nothing.
 *
 * ── TEAM AND BUNDLE ARE CONFIGURED, NOT DERIVED ────────────────────────────
 *
 * Both are stated outright rather than being reconstructed from the app id in
 * the association document. They are what `iss` and `apns-topic` are built
 * from, and a deployment must be able to set them without editing source.
 */
export interface ApnsKeyCredentials {
  /** The `kid` header of the provider token: the Key ID of the .p8. */
  keyId: string;
  /** PEM contents of the .p8 file. Never logged, never returned to a caller. */
  privateKey: string;
}

export interface ApnsConfiguration {
  teamId: string;
  bundleId: string;
  /** `null` for an environment with no key configured. */
  keys: Record<ApnsEnvironment, ApnsKeyCredentials | null>;
}

/**
 * A .p8 is a multi-line PEM, and most secret stores hand it back with the
 * newlines escaped. Both spellings are accepted so the value can be pasted into
 * whichever dashboard is at hand without a silent parse failure.
 */
function readPrivateKeyVariable(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

function readKeyPair(keyIdName: string, privateKeyName: string): ApnsKeyCredentials | null {
  const keyId = process.env[keyIdName];
  const privateKey = readPrivateKeyVariable(process.env[privateKeyName]);

  if (keyId === undefined || keyId.trim() === '' || privateKey === null) {
    return null;
  }

  return { keyId: keyId.trim(), privateKey };
}

/**
 * Reads APNs configuration, or returns `null` when there is none.
 *
 * `null` rather than a throw, exactly as `readVapidConfiguration` does: a
 * deployment without APNs credentials must still run the whole product, and by
 * the time this is consulted the canonical notification is already saved. No
 * credentials means "in-app only", not an outage.
 *
 * One environment configured and not the other is a valid state, and a common
 * one — a deployment serving the App Store build has no reason to hold a
 * sandbox key. Devices in the unconfigured environment are skipped rather than
 * failed; see `createApnsSender`.
 */
export function readApnsConfiguration(): ApnsConfiguration | null {
  const teamId = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID;

  if (
    teamId === undefined ||
    teamId.trim() === '' ||
    bundleId === undefined ||
    bundleId.trim() === ''
  ) {
    return null;
  }

  const keys: Record<ApnsEnvironment, ApnsKeyCredentials | null> = {
    // `sandbox` is Apple's name for it; `development` is the entitlement's and
    // the column's. Same environment throughout.
    development: readKeyPair('APNS_SANDBOX_KEY_ID', 'APNS_SANDBOX_PRIVATE_KEY'),
    production: readKeyPair('APNS_PRODUCTION_KEY_ID', 'APNS_PRODUCTION_PRIVATE_KEY'),
  };

  if (keys.development === null && keys.production === null) {
    return null;
  }

  return { teamId: teamId.trim(), bundleId: bundleId.trim(), keys };
}

// ── Provider token ─────────────────────────────────────────────────────────

interface CachedProviderToken {
  token: string;
  issuedAtMs: number;
}

/**
 * One cached JWT per signing key.
 *
 * Keyed by team and key id rather than by environment, because a legacy
 * dual-environment key configured in both pairs is genuinely the same
 * credential and should be minted once. A provider token names the team and the
 * key and says nothing about sandbox or production.
 */
const providerTokenCache = new Map<string, CachedProviderToken>();

function providerTokenCacheKey(teamId: string, credentials: ApnsKeyCredentials): string {
  return `${teamId}:${credentials.keyId}`;
}

/**
 * Fifty minutes. Comfortably inside Apple's one-hour maximum and comfortably
 * outside its twenty-minute minimum between refreshes.
 */
const PROVIDER_TOKEN_LIFETIME_MS = 50 * 60 * 1000;

function base64Url(input: Buffer | string): string {
  return (typeof input === 'string' ? Buffer.from(input) : input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * The signing JWT for one key, minted at most every fifty minutes.
 *
 * Cached in module scope, which on a serverless platform means "for as long as
 * this instance stays warm" — the useful lifetime, and the reason a fanout of
 * twenty devices signs once rather than twenty times.
 *
 * `now` is a parameter so the expiry can be tested without waiting fifty
 * minutes or mocking the clock globally.
 */
export function createProviderToken(
  teamId: string,
  credentials: ApnsKeyCredentials,
  now: number = Date.now(),
): string {
  const cacheKey = providerTokenCacheKey(teamId, credentials);
  const cached = providerTokenCache.get(cacheKey);

  if (cached !== undefined && now - cached.issuedAtMs < PROVIDER_TOKEN_LIFETIME_MS) {
    return cached.token;
  }

  const issuedAtSeconds = Math.floor(now / 1000);
  const header = base64Url(JSON.stringify({ alg: 'ES256', kid: credentials.keyId }));
  // `iss` and `iat` only. APNs provider tokens carry no audience and no expiry
  // claim; Apple derives the expiry from `iat`.
  const claims = base64Url(JSON.stringify({ iss: teamId, iat: issuedAtSeconds }));
  const signingInput = `${header}.${claims}`;

  let key: KeyObject;
  try {
    key = createPrivateKey(credentials.privateKey);
  } catch (error: unknown) {
    // Rethrown with nothing borrowed from the original. A key parse error can
    // quote the material it failed on.
    void error;
    throw new Error('The configured APNs private key could not be read');
  }

  const signature = sign('sha256', Buffer.from(signingInput), {
    key,
    // JWS wants the raw r‖s pair, not the DER structure Node emits by default.
    dsaEncoding: 'ieee-p1363',
  });

  const token = `${signingInput}.${base64Url(signature)}`;
  providerTokenCache.set(cacheKey, { token, issuedAtMs: now });
  return token;
}

/**
 * Drops one key's cached JWT, so the next send mints a new one.
 *
 * Called when APNs answers `ExpiredProviderToken`, which is the one failure
 * that is entirely ours to fix and can be fixed immediately. Apple expires a
 * provider token an hour after `iat`, and a serverless instance that was frozen
 * across that boundary wakes holding a token it believes is fresh — there is no
 * clock it could have consulted to know otherwise.
 */
export function invalidateProviderToken(teamId: string, credentials: ApnsKeyCredentials): void {
  providerTokenCache.delete(providerTokenCacheKey(teamId, credentials));
}

/** Test seam: drops every cached provider token. */
export function resetProviderTokenCache(): void {
  providerTokenCache.clear();
}

// ── Transport ──────────────────────────────────────────────────────────────

export interface ApnsRequest {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface ApnsResponse {
  status: number;
  body: string;
}

/**
 * The one thing that touches the network, so that everything above it — the
 * envelope, the headers, the classification — is testable with a fake.
 */
export interface ApnsTransport {
  post(request: ApnsRequest): Promise<ApnsResponse>;
}

/** How long a single POST may take before it is abandoned as a timeout. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * HTTP/2 over `node:http2`, one connection per send.
 *
 * ── WHY NOT A POOLED CONNECTION ────────────────────────────────────────────
 *
 * A cached session is the obvious optimisation and the wrong default here.
 * These sends run on a serverless instance that is frozen between invocations,
 * so a pooled session is usually dead by the time it is reused, and keeping it
 * alive means either holding the event loop open — delaying the freeze and
 * paying for it — or `unref`-ing it and racing the runtime to finish the
 * request.
 *
 * A handshake per notification is a real cost, and it is paid on a best-effort
 * path that runs after the domain transaction has already committed. If fanouts
 * grow to the point where it matters, the fix is to reuse one session for the
 * duration of a single dispatch — not to cache one across invocations.
 */
export function createHttp2ApnsTransport(): ApnsTransport {
  return {
    async post({ host, path, headers, body }) {
      const http2 = await import('node:http2');
      const session = http2.connect(`https://${host}`);

      try {
        return await new Promise<ApnsResponse>((resolve, reject) => {
          session.on('error', reject);

          const stream = session.request({
            ...headers,
            [http2.constants.HTTP2_HEADER_METHOD]: 'POST',
            [http2.constants.HTTP2_HEADER_PATH]: path,
          });

          let status = 0;
          let text = '';

          stream.setEncoding('utf8');
          stream.on('response', (responseHeaders) => {
            status = Number(responseHeaders[http2.constants.HTTP2_HEADER_STATUS] ?? 0);
          });
          stream.on('data', (chunk: string) => {
            text += chunk;
          });
          stream.on('end', () => resolve({ status, body: text }));
          stream.on('error', reject);
          stream.setTimeout(REQUEST_TIMEOUT_MS, () => {
            stream.close(http2.constants.NGHTTP2_CANCEL);
            reject(Object.assign(new Error('APNs request timed out'), { name: 'TimeoutError' }));
          });

          stream.end(body);
        });
      } finally {
        session.close();
      }
    },
  };
}

// ── Sender ─────────────────────────────────────────────────────────────────

/** Twelve hours, matching the Web Push TTL. A match alert is worthless later. */
const EXPIRATION_SECONDS = 60 * 60 * 12;

/**
 * The APNs payload envelope.
 *
 * `aps` is Apple's; `url` and `notificationId` sit beside it as custom data and
 * are what the app reads when somebody taps the notification.
 *
 * Nothing is spread in from anywhere. The four fields are the four
 * `buildPushPayload` produced, and that function is already the single place
 * that decides what may appear on a lock screen — see `push-payload.test.ts`.
 */
export function buildApnsBody(payload: PushPayload): string {
  return JSON.stringify({
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: 'default',
    },
    url: payload.url,
    notificationId: payload.notificationId,
  });
}

/**
 * Reads the `reason` out of an APNs error body.
 *
 * The body is `{"reason":"BadDeviceToken"}` and, on a 410, also a `timestamp`.
 * Only the reason is taken, and it is taken structurally: the raw body is never
 * returned to a caller, stored, or logged.
 */
export function parseApnsReason(body: string): string | null {
  if (body.trim() === '') {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && 'reason' in parsed) {
      const reason = (parsed as { reason: unknown }).reason;
      return typeof reason === 'string' ? reason : null;
    }
  } catch {
    // A body that is not JSON tells us nothing; the status still classifies.
  }

  return null;
}

/**
 * The real APNs sender.
 *
 * The transport is injected so the unit suite can exercise every rejection
 * Apple documents without a network — see `tests/unit/push-apns.test.ts`.
 */
export function createApnsSender(
  config: ApnsConfiguration,
  transport: ApnsTransport = createHttp2ApnsTransport(),
): PushSender {
  return {
    async send(target: PushTarget, payload: PushPayload): Promise<PushSendOutcome> {
      // Guards the union rather than assuming: the routing sender is what picks
      // a channel, and a mis-wired one should fail loudly here in tests rather
      // than POST a Web Push endpoint to Apple.
      if (target.channel !== 'apns') {
        return { ok: false, error: new Error('An APNs sender was given a Web Push target') };
      }

      // No key for this device's environment. Skipped rather than failed, so a
      // deployment holding only a production key does not accumulate terminal
      // rows against its development devices — and adding the other key later
      // simply starts working.
      const credentials = config.keys[target.environment];
      if (credentials === null) {
        return { ok: false, unsupported: true };
      }

      try {
        const attempt = async (): Promise<ApnsResponse> =>
          transport.post({
            host: APNS_HOSTS[target.environment],
            path: `/3/device/${target.deviceToken}`,
            headers: {
              authorization: `bearer ${createProviderToken(config.teamId, credentials)}`,
              'apns-topic': config.bundleId,
              // `alert` is required on iOS 13+ and must match the payload. A
              // notification with an `alert` sent as `background` is dropped
              // silently.
              'apns-push-type': 'alert',
              // 10 is "deliver now". These are time-critical by construction —
              // nothing that is not push-eligible reaches here.
              'apns-priority': '10',
              'apns-expiration': String(Math.floor(Date.now() / 1000) + EXPIRATION_SECONDS),
            },
            body: buildApnsBody(payload),
          });

        let response = await attempt();

        // ── One retry, for the one failure we can fix in place ──────────────
        //
        // `ExpiredProviderToken` means the cached JWT aged past Apple's
        // one-hour limit — which a serverless instance cannot notice on its
        // own, having been frozen across the boundary. Dropping the cache and
        // signing again resolves it immediately, and not retrying would mean
        // recording a permanent failure for a notification that would have gone
        // through a moment later.
        //
        // Straight-line and deliberately not a loop: exactly one extra attempt,
        // whatever the second answer is. A retry that could re-enter would
        // hammer APNs with a credential problem it has already refused, which
        // is how `TooManyProviderTokenUpdates` happens.
        //
        // Only the final response is returned, so the caller records one
        // outcome per (notification, subscription) — the recovered attempt
        // leaves no failure behind it.
        if (response.status === 403 && parseApnsReason(response.body) === 'ExpiredProviderToken') {
          invalidateProviderToken(config.teamId, credentials);
          response = await attempt();
        }

        if (response.status === 200) {
          return { ok: true };
        }

        return {
          ok: false,
          apnsStatus: response.status,
          apnsReason: parseApnsReason(response.body),
        };
      } catch (error: unknown) {
        // Handed on unmodified for `classifyPushError` to inspect structurally,
        // and never logged: an http2 error can quote the request path, which
        // contains the device token.
        return { ok: false, error };
      }
    },
  };
}

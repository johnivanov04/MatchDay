import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildApnsBody,
  createApnsSender,
  createProviderToken,
  invalidateProviderToken,
  parseApnsReason,
  readApnsConfiguration,
  resetProviderTokenCache,
  type ApnsConfiguration,
  type ApnsKeyCredentials,
  type ApnsRequest,
  type ApnsResponse,
  type ApnsTransport,
} from '@/lib/push/apns';
import type { PushPayload } from '@/lib/push/payload';
import type { PushTarget } from '@/lib/push/sender';

/**
 * The APNs transport, exercised without a network.
 *
 * Everything Apple can say to us is a status and a reason string, and every one
 * of them is reachable here through a fake — which matters because the
 * alternative is discovering the difference between "this phone is gone" and
 * "your signing key expired" in production, after the second has already
 * unsubscribed everybody.
 */

function generateKey(): string {
  return generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

const SANDBOX_KEY = generateKey();
const PRODUCTION_KEY = generateKey();

const SANDBOX_CREDENTIALS: ApnsKeyCredentials = {
  keyId: 'SANDBOX123',
  privateKey: SANDBOX_KEY,
};
const PRODUCTION_CREDENTIALS: ApnsKeyCredentials = {
  keyId: 'PRODUCTN456',
  privateKey: PRODUCTION_KEY,
};

const CONFIG: ApnsConfiguration = {
  teamId: 'VYC3499K46',
  bundleId: 'com.johnivanov.matchday',
  keys: { development: SANDBOX_CREDENTIALS, production: PRODUCTION_CREDENTIALS },
};

const PAYLOAD: PushPayload = {
  title: 'New match: Monday night 11v11',
  body: 'Mon 17 Aug 19:00 at RMV Community Pitch',
  url: '/leagues/rmv-football-club/matches/aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  notificationId: '11111111-1111-4111-8111-000000000001',
};

const APNS_TARGET: Extract<PushTarget, { channel: 'apns' }> = {
  channel: 'apns',
  subscriptionId: 'subscription-1',
  deviceToken: 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90',
  environment: 'production',
};

/** Records what was asked of it and replies with whatever the test wants. */
function createTransport(
  reply: ApnsResponse | ApnsResponse[] | (() => Promise<never>),
): { transport: ApnsTransport; requests: ApnsRequest[] } {
  const requests: ApnsRequest[] = [];
  return {
    requests,
    transport: {
      post: async (request) => {
        requests.push(request);
        if (typeof reply === 'function') {
          return reply();
        }
        if (Array.isArray(reply)) {
          // Each call takes the next scripted reply; the last one repeats, so a
          // test that expects no further calls fails loudly rather than
          // throwing an index error that could be mistaken for the assertion.
          return reply[Math.min(requests.length - 1, reply.length - 1)] as ApnsResponse;
        }
        return reply;
      },
    },
  };
}

const EXPIRED_PROVIDER_TOKEN: ApnsResponse = {
  status: 403,
  body: '{"reason":"ExpiredProviderToken"}',
};

beforeEach(() => {
  resetProviderTokenCache();
});

describe('readApnsConfiguration', () => {
  const saved = { ...process.env };

  function setEnvironment(values: Record<string, string | undefined>): void {
    for (const name of [
      'APNS_TEAM_ID',
      'APNS_BUNDLE_ID',
      'APNS_SANDBOX_KEY_ID',
      'APNS_SANDBOX_PRIVATE_KEY',
      'APNS_PRODUCTION_KEY_ID',
      'APNS_PRODUCTION_PRIVATE_KEY',
    ]) {
      delete process.env[name];
    }
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined) {
        process.env[name] = value;
      }
    }
  }

  afterEach(() => {
    process.env = { ...saved };
  });

  const BOTH = {
    APNS_TEAM_ID: 'VYC3499K46',
    APNS_BUNDLE_ID: 'com.johnivanov.matchday',
    APNS_SANDBOX_KEY_ID: 'SANDBOX123',
    APNS_SANDBOX_PRIVATE_KEY: SANDBOX_KEY,
    APNS_PRODUCTION_KEY_ID: 'PRODUCTN456',
    APNS_PRODUCTION_PRIVATE_KEY: PRODUCTION_KEY,
  };

  it('is null when nothing is configured, so push degrades to in-app only', () => {
    setEnvironment({});
    expect(readApnsConfiguration()).toBeNull();
  });

  it('reads a separate key for each environment', () => {
    setEnvironment(BOTH);

    expect(readApnsConfiguration()).toEqual({
      teamId: 'VYC3499K46',
      bundleId: 'com.johnivanov.matchday',
      keys: {
        development: { keyId: 'SANDBOX123', privateKey: SANDBOX_KEY },
        production: { keyId: 'PRODUCTN456', privateKey: PRODUCTION_KEY },
      },
    });
  });

  it.each([['APNS_TEAM_ID'], ['APNS_BUNDLE_ID']])(
    'is null without %s, which every request needs',
    (name) => {
      setEnvironment({ ...BOTH, [name]: undefined });
      expect(readApnsConfiguration()).toBeNull();
    },
  );

  describe('one environment configured and not the other', () => {
    /**
     * A normal state, not a broken one: a deployment serving only the App Store
     * build has no reason to hold a sandbox key. Its devices are skipped rather
     * than failed — see the sender.
     */
    it('keeps the configured one and leaves the other null', () => {
      setEnvironment({
        APNS_TEAM_ID: BOTH.APNS_TEAM_ID,
        APNS_BUNDLE_ID: BOTH.APNS_BUNDLE_ID,
        APNS_PRODUCTION_KEY_ID: BOTH.APNS_PRODUCTION_KEY_ID,
        APNS_PRODUCTION_PRIVATE_KEY: BOTH.APNS_PRODUCTION_PRIVATE_KEY,
      });

      const config = readApnsConfiguration();
      expect(config?.keys.development).toBeNull();
      expect(config?.keys.production).toMatchObject({ keyId: 'PRODUCTN456' });
    });

    it('is null when a key id is set without its key, rather than half-configured', () => {
      setEnvironment({
        APNS_TEAM_ID: BOTH.APNS_TEAM_ID,
        APNS_BUNDLE_ID: BOTH.APNS_BUNDLE_ID,
        APNS_PRODUCTION_KEY_ID: BOTH.APNS_PRODUCTION_KEY_ID,
      });

      expect(readApnsConfiguration()).toBeNull();
    });
  });

  it('accepts one legacy key configured in both pairs', () => {
    // Keys issued before Apple separated the environments work in both. An
    // operator holding one configures it twice, which must be supported rather
    // than detected and rejected.
    setEnvironment({
      ...BOTH,
      APNS_SANDBOX_KEY_ID: 'LEGACY0001',
      APNS_SANDBOX_PRIVATE_KEY: SANDBOX_KEY,
      APNS_PRODUCTION_KEY_ID: 'LEGACY0001',
      APNS_PRODUCTION_PRIVATE_KEY: SANDBOX_KEY,
    });

    const config = readApnsConfiguration();
    expect(config?.keys.development).toEqual(config?.keys.production);
  });

  it.each([['APNS_SANDBOX_PRIVATE_KEY'], ['APNS_PRODUCTION_PRIVATE_KEY']])(
    'accepts %s with newlines escaped by a secret store',
    (name) => {
      const original = name.includes('SANDBOX') ? SANDBOX_KEY : PRODUCTION_KEY;
      setEnvironment({ ...BOTH, [name]: original.replace(/\n/g, '\\n') });

      const config = readApnsConfiguration();
      const credentials = name.includes('SANDBOX')
        ? config?.keys.development
        : config?.keys.production;

      expect(credentials?.privateKey).toBe(original);
      // The real test of that: it still signs.
      expect(() =>
        createProviderToken('VYC3499K46', credentials as ApnsKeyCredentials),
      ).not.toThrow();
    },
  );
});

describe('the provider token', () => {
  function decode(part: string): unknown {
    return JSON.parse(
      Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
  }

  it('is a JWT naming the key and the team', () => {
    const [header, claims, signature] = createProviderToken(
      CONFIG.teamId,
      PRODUCTION_CREDENTIALS,
      1_700_000_000_000,
    ).split('.');

    expect(decode(header ?? '')).toEqual({ alg: 'ES256', kid: 'PRODUCTN456' });
    // `iss` and `iat` only: APNs provider tokens carry no audience and no
    // expiry claim.
    expect(decode(claims ?? '')).toEqual({ iss: 'VYC3499K46', iat: 1_700_000_000 });
    expect(signature).toBeTruthy();
  });

  it('is signed in the JWS form, not the DER one Node produces by default', () => {
    /**
     * The single easiest thing to get wrong here. A DER signature is accepted
     * by `crypto.verify` in its own encoding and rejected by APNs as
     * `InvalidProviderToken`, with nothing in the error hinting at the cause.
     * This verifies with `ieee-p1363` explicitly, which only passes for the raw
     * r‖s pair JWS requires.
     */
    const credentials: ApnsKeyCredentials = { keyId: 'VERIFY0001', privateKey: generateKey() };
    const token = createProviderToken('VYC3499K46', credentials, 1_700_000_000_000);
    const [header, claims, signature] = token.split('.');

    const verified = verify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      { key: createPublicKey(credentials.privateKey), dsaEncoding: 'ieee-p1363' },
      Buffer.from((signature ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
    );

    expect(verified).toBe(true);
  });

  it('carries no padding or URL-unsafe characters', () => {
    expect(createProviderToken(CONFIG.teamId, PRODUCTION_CREDENTIALS, 1_700_000_000_000)).not.toMatch(
      /[+/=]/,
    );
  });

  describe('is reused rather than minted per notification', () => {
    /**
     * Apple refuses more than one refresh per twenty minutes with
     * `TooManyProviderTokenUpdates`. Signing per send passes every test that
     * sends one notification and fails the first real fanout.
     */
    it('returns the same token throughout a fanout', () => {
      const first = createProviderToken(CONFIG.teamId, PRODUCTION_CREDENTIALS, 1_700_000_000_000);
      const second = createProviderToken(
        CONFIG.teamId,
        PRODUCTION_CREDENTIALS,
        1_700_000_000_000 + 60_000,
      );
      expect(second).toBe(first);
    });

    it('mints a new one before Apple’s one-hour maximum', () => {
      const first = createProviderToken(CONFIG.teamId, PRODUCTION_CREDENTIALS, 1_700_000_000_000);
      const later = createProviderToken(
        CONFIG.teamId,
        PRODUCTION_CREDENTIALS,
        1_700_000_000_000 + 51 * 60 * 1000,
      );
      expect(later).not.toBe(first);
    });

    it('keeps one cache entry per key, so two environments do not evict each other', () => {
      // With a single slot, a fanout alternating between a sandbox device and a
      // production device would re-sign on every send and earn
      // `TooManyProviderTokenUpdates` from both.
      const sandbox = createProviderToken(CONFIG.teamId, SANDBOX_CREDENTIALS, 1_700_000_000_000);
      const production = createProviderToken(
        CONFIG.teamId,
        PRODUCTION_CREDENTIALS,
        1_700_000_000_000,
      );

      expect(sandbox).not.toBe(production);
      expect(createProviderToken(CONFIG.teamId, SANDBOX_CREDENTIALS, 1_700_000_000_001)).toBe(
        sandbox,
      );
      expect(createProviderToken(CONFIG.teamId, PRODUCTION_CREDENTIALS, 1_700_000_000_001)).toBe(
        production,
      );
    });
  });

  describe('invalidateProviderToken', () => {
    it('forces the next call to mint a fresh one', () => {
      const first = createProviderToken(CONFIG.teamId, PRODUCTION_CREDENTIALS, 1_700_000_000_000);
      invalidateProviderToken(CONFIG.teamId, PRODUCTION_CREDENTIALS);

      // Same instant, so `iat` is identical — the tokens still differ, because
      // ECDSA signing is randomised. What matters is that the cache was not
      // consulted.
      const second = createProviderToken(CONFIG.teamId, PRODUCTION_CREDENTIALS, 1_700_000_000_000);
      expect(second).not.toBe(first);
    });

    it('leaves the other key’s cached token alone', () => {
      const sandbox = createProviderToken(CONFIG.teamId, SANDBOX_CREDENTIALS, 1_700_000_000_000);
      createProviderToken(CONFIG.teamId, PRODUCTION_CREDENTIALS, 1_700_000_000_000);

      invalidateProviderToken(CONFIG.teamId, PRODUCTION_CREDENTIALS);

      expect(createProviderToken(CONFIG.teamId, SANDBOX_CREDENTIALS, 1_700_000_000_000)).toBe(
        sandbox,
      );
    });
  });

  it('reports an unreadable key without quoting it', () => {
    expect(() =>
      createProviderToken(CONFIG.teamId, { keyId: 'BAD0000001', privateKey: 'not a key' }),
    ).toThrowError('The configured APNs private key could not be read');
  });
});

describe('the payload envelope', () => {
  it('carries the alert, and the deep link beside it as custom data', () => {
    expect(JSON.parse(buildApnsBody(PAYLOAD))).toEqual({
      aps: {
        alert: { title: PAYLOAD.title, body: PAYLOAD.body },
        sound: 'default',
      },
      url: PAYLOAD.url,
      notificationId: PAYLOAD.notificationId,
    });
  });

  it('adds nothing of its own to what buildPushPayload allowed', () => {
    // `push-payload.test.ts` proves the four fields are the only ones that can
    // reach a lock screen. This proves the envelope does not widen that.
    const body: unknown = JSON.parse(buildApnsBody(PAYLOAD));
    expect(Object.keys(body as Record<string, unknown>).sort()).toEqual([
      'aps',
      'notificationId',
      'url',
    ]);
  });
});

describe('parseApnsReason', () => {
  it('reads the reason out of an error body', () => {
    expect(parseApnsReason('{"reason":"BadDeviceToken"}')).toBe('BadDeviceToken');
  });

  it('ignores the timestamp APNs adds to a 410', () => {
    expect(parseApnsReason('{"reason":"Unregistered","timestamp":1454948015990}')).toBe(
      'Unregistered',
    );
  });

  it.each([[''], ['   '], ['not json'], ['{}'], ['{"reason":42}'], ['[]']])(
    'is null for %s',
    (body) => {
      expect(parseApnsReason(body)).toBeNull();
    },
  );
});

describe('createApnsSender', () => {
  it('POSTs to the device path with the headers APNs requires', async () => {
    const { transport, requests } = createTransport({ status: 200, body: '' });
    const outcome = await createApnsSender(CONFIG, transport).send(APNS_TARGET, PAYLOAD);

    expect(outcome).toEqual({ ok: true });
    expect(requests).toHaveLength(1);

    const request = requests[0];
    expect(request?.path).toBe(`/3/device/${APNS_TARGET.deviceToken}`);
    expect(request?.headers['apns-topic']).toBe('com.johnivanov.matchday');
    // `alert` is required on iOS 13+ and must match the payload; a notification
    // with an `alert` sent as `background` is dropped without a word.
    expect(request?.headers['apns-push-type']).toBe('alert');
    expect(request?.headers['apns-priority']).toBe('10');
    expect(request?.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(Number(request?.headers['apns-expiration'])).toBeGreaterThan(Date.now() / 1000);
  });

  it.each([
    ['production', 'api.push.apple.com'],
    ['development', 'api.sandbox.push.apple.com'],
  ] as const)('sends a %s token to %s', async (environment, host) => {
    /**
     * The reason `apns_environment` is a stored column rather than a guess. A
     * token sent to the wrong host comes back `BadDeviceToken`, which is
     * indistinguishable from a corrupt token and would retire a perfectly good
     * device.
     */
    const { transport, requests } = createTransport({ status: 200, body: '' });
    await createApnsSender(CONFIG, transport).send({ ...APNS_TARGET, environment }, PAYLOAD);

    expect(requests[0]?.host).toBe(host);
  });

  describe('credential selection', () => {
    function keyIdOf(request: ApnsRequest | undefined): unknown {
      const header = (request?.headers.authorization ?? '').slice('bearer '.length).split('.')[0];
      return JSON.parse(
        Buffer.from((header ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
          'utf8',
        ),
      );
    }

    it.each([
      ['development', 'SANDBOX123'],
      ['production', 'PRODUCTN456'],
    ] as const)('signs a %s send with that environment’s key', async (environment, keyId) => {
      const { transport, requests } = createTransport({ status: 200, body: '' });
      await createApnsSender(CONFIG, transport).send({ ...APNS_TARGET, environment }, PAYLOAD);

      expect(keyIdOf(requests[0])).toMatchObject({ kid: keyId });
    });

    it('skips a device whose environment has no key, rather than failing it', async () => {
      // Skipping records nothing, so configuring the other key later starts
      // delivery with no terminal rows to unpick.
      const { transport, requests } = createTransport({ status: 200, body: '' });
      const sender = createApnsSender(
        { ...CONFIG, keys: { development: null, production: PRODUCTION_CREDENTIALS } },
        transport,
      );

      const outcome = await sender.send({ ...APNS_TARGET, environment: 'development' }, PAYLOAD);

      expect(outcome).toEqual({ ok: false, unsupported: true });
      expect(requests).toHaveLength(0);
    });
  });

  describe('an expired provider token', () => {
    /**
     * The one failure entirely ours to fix, and fixable immediately. A
     * serverless instance frozen across Apple's one-hour expiry wakes holding a
     * token it believes is fresh; there is no clock it could have consulted.
     */
    it('drops the cached JWT, signs a new one, and retries once', async () => {
      const { transport, requests } = createTransport([
        EXPIRED_PROVIDER_TOKEN,
        { status: 200, body: '' },
      ]);

      const outcome = await createApnsSender(CONFIG, transport).send(APNS_TARGET, PAYLOAD);

      expect(outcome).toEqual({ ok: true });
      expect(requests).toHaveLength(2);
      // A genuinely different token, not the cached one replayed.
      expect(requests[1]?.headers.authorization).not.toBe(requests[0]?.headers.authorization);
    });

    it('records only the final outcome, so a recovered send leaves no failure', async () => {
      const { transport } = createTransport([EXPIRED_PROVIDER_TOKEN, { status: 200, body: '' }]);
      const outcome = await createApnsSender(CONFIG, transport).send(APNS_TARGET, PAYLOAD);

      // One outcome, and it is the successful one. `dispatch` records exactly
      // what `send` returns.
      expect(outcome).toEqual({ ok: true });
    });

    it('cannot loop: a second expiry is reported, not retried again', async () => {
      // The retry is straight-line, not recursive. Retrying a credential
      // problem APNs has already refused is how `TooManyProviderTokenUpdates`
      // happens.
      const { transport, requests } = createTransport(EXPIRED_PROVIDER_TOKEN);

      const outcome = await createApnsSender(CONFIG, transport).send(APNS_TARGET, PAYLOAD);

      expect(requests).toHaveLength(2);
      expect(outcome).toEqual({
        ok: false,
        apnsStatus: 403,
        apnsReason: 'ExpiredProviderToken',
      });
    });

    it('classifies the retry’s answer normally when it fails differently', async () => {
      const { transport, requests } = createTransport([
        EXPIRED_PROVIDER_TOKEN,
        { status: 410, body: '{"reason":"Unregistered"}' },
      ]);

      const outcome = await createApnsSender(CONFIG, transport).send(APNS_TARGET, PAYLOAD);

      expect(requests).toHaveLength(2);
      expect(outcome).toEqual({ ok: false, apnsStatus: 410, apnsReason: 'Unregistered' });
    });

    it('does not retry any other rejection', async () => {
      const { transport, requests } = createTransport({
        status: 403,
        body: '{"reason":"InvalidProviderToken"}',
      });

      await createApnsSender(CONFIG, transport).send(APNS_TARGET, PAYLOAD);

      // An invalid key is not an expired one; signing again produces the same
      // rejection and burns a token update doing it.
      expect(requests).toHaveLength(1);
    });
  });

  describe('Apple’s apns-id', () => {
    /**
     * The only handle Apple's support and delivery-status tooling recognise.
     * Build #2 shipped without it: the first production send was recorded as
     * `sent`, which answers "did Apple take it" and not "which one".
     */
    const APNS_ID = '8B2E0B0E-4C3D-4F1A-9E77-2A6D5C1B0F42';

    it('is carried on a successful send', async () => {
      const { transport } = createTransport({ status: 200, body: '', apnsId: APNS_ID });
      const outcome = await createApnsSender(CONFIG, transport).send(APNS_TARGET, PAYLOAD);

      expect(outcome).toEqual({ ok: true, providerMessageId: APNS_ID });
    });

    it('is carried on a rejection too, which is the one somebody asks about', async () => {
      const { transport } = createTransport({
        status: 410,
        body: '{"reason":"Unregistered"}',
        apnsId: APNS_ID,
      });
      const outcome = await createApnsSender(CONFIG, transport).send(APNS_TARGET, PAYLOAD);

      expect(outcome).toEqual({
        ok: false,
        apnsStatus: 410,
        apnsReason: 'Unregistered',
        providerMessageId: APNS_ID,
      });
    });

    it('is simply absent when Apple sent none', async () => {
      // `exactOptionalPropertyTypes` distinguishes an absent key from one set
      // to undefined, and the database column is nullable for the same reason.
      const { transport } = createTransport({ status: 200, body: '' });
      const outcome = await createApnsSender(CONFIG, transport).send(APNS_TARGET, PAYLOAD);

      expect(outcome).toEqual({ ok: true });
      expect(Object.keys(outcome)).not.toContain('providerMessageId');
    });

    it('does not change delivery semantics', async () => {
      // Same status in, same ok/not-ok out, with or without the header.
      const withId = await createApnsSender(
        CONFIG,
        createTransport({ status: 200, body: '', apnsId: APNS_ID }).transport,
      ).send(APNS_TARGET, PAYLOAD);
      const withoutId = await createApnsSender(
        CONFIG,
        createTransport({ status: 200, body: '' }).transport,
      ).send(APNS_TARGET, PAYLOAD);

      expect(withId.ok).toBe(true);
      expect(withoutId.ok).toBe(true);
    });

    it('exposes no credential or device token alongside it', async () => {
      const { transport } = createTransport({ status: 200, body: '', apnsId: APNS_ID });
      const outcome = await createApnsSender(CONFIG, transport).send(APNS_TARGET, PAYLOAD);

      const serialised = JSON.stringify(outcome);
      expect(serialised).not.toContain(APNS_TARGET.deviceToken);
      expect(serialised).not.toContain('BEGIN');
      expect(serialised).not.toContain(CONFIG.keys.production?.keyId ?? 'PRODUCTN456');
    });
  });

  it('reports the status and the reason, so the caller can tell them apart', async () => {
    const { transport } = createTransport({ status: 410, body: '{"reason":"Unregistered"}' });
    const outcome = await createApnsSender(CONFIG, transport).send(APNS_TARGET, PAYLOAD);

    expect(outcome).toEqual({ ok: false, apnsStatus: 410, apnsReason: 'Unregistered' });
  });

  it('reports a status with no readable reason rather than inventing one', async () => {
    const { transport } = createTransport({ status: 503, body: '' });
    const outcome = await createApnsSender(CONFIG, transport).send(APNS_TARGET, PAYLOAD);

    expect(outcome).toEqual({ ok: false, apnsStatus: 503, apnsReason: null });
  });

  it('returns a failure rather than throwing when the connection does', async () => {
    const failure = new Error('socket hang up');
    const { transport } = createTransport(() => Promise.reject(failure));
    const outcome = await createApnsSender(CONFIG, transport).send(APNS_TARGET, PAYLOAD);

    expect(outcome).toEqual({ ok: false, error: failure });
  });

  it('refuses a Web Push target instead of POSTing an endpoint to Apple', async () => {
    const { transport, requests } = createTransport({ status: 200, body: '' });
    const outcome = await createApnsSender(CONFIG, transport).send(
      {
        channel: 'web_push',
        subscriptionId: 'subscription-2',
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        p256dh: 'key',
        auth: 'secret',
      },
      PAYLOAD,
    );

    expect(outcome).toMatchObject({ ok: false });
    expect(requests).toHaveLength(0);
  });

  it('signs once for a whole fanout', async () => {
    const { transport, requests } = createTransport({ status: 200, body: '' });
    const sender = createApnsSender(CONFIG, transport);

    for (const deviceToken of ['AABBCCDD', 'EEFF0011', '22334455']) {
      await sender.send({ ...APNS_TARGET, deviceToken }, PAYLOAD);
    }

    const tokens = new Set(requests.map((request) => request.headers.authorization));
    expect(tokens.size).toBe(1);
  });
});

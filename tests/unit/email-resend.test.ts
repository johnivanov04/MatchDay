import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createResendSender,
  emailIdempotencyKey,
  readEmailConfiguration,
  type EmailConfiguration,
  type EmailTransport,
} from '@/lib/email/resend';
import { renderNotificationEmail } from '@/lib/email/template';

/**
 * The Resend transport, exercised without a network.
 *
 * Nothing here may reach the real provider, so the transport is injected in
 * every test. A test that accidentally sent a real email would be a test that
 * charged somebody money and mailed a stranger.
 */

const CONFIG: EmailConfiguration = {
  apiKey: 'test-api-key-value-not-real',
  from: 'MatchDay <notifications@example.test>',
};

const NOTIFICATION_ID = '11111111-1111-4111-8111-000000000001';

const RENDERED = renderNotificationEmail({
  title: 'New match: Monday night 11v11',
  body: 'Mon 17 Aug 19:00 at RMV Community Pitch',
  url: 'https://app.matchdayapps.com/leagues/rmv/matches/abc',
  settingsUrl: 'https://app.matchdayapps.com/settings/notifications',
});

function message(overrides: Partial<{ to: string; idempotencyKey: string }> = {}) {
  return {
    to: overrides.to ?? 'player@example.test',
    rendered: RENDERED,
    idempotencyKey: overrides.idempotencyKey ?? emailIdempotencyKey(NOTIFICATION_ID),
  };
}

/** Records what was asked of it and replies with whatever the test wants. */
function createTransport(
  reply: { status: number; json: unknown } | (() => Promise<never>),
): {
  transport: EmailTransport;
  requests: Array<{ url: string; apiKey: string; idempotencyKey: string; body: unknown }>;
} {
  const requests: Array<{ url: string; apiKey: string; idempotencyKey: string; body: unknown }> =
    [];
  return {
    requests,
    transport: {
      post: async (request) => {
        requests.push(request);
        if (typeof reply === 'function') {
          return reply();
        }
        return reply;
      },
    },
  };
}

describe('the provider idempotency key', () => {
  it('is deterministic for a notification', () => {
    expect(emailIdempotencyKey(NOTIFICATION_ID)).toBe(emailIdempotencyKey(NOTIFICATION_ID));
  });

  it('is the SAME on every retry, which is the entire point', () => {
    // The queue is at-least-once: a worker can be killed after Resend accepts a
    // message and before MatchDay records it. A stable key is what stops the
    // next pass putting a second copy in somebody's inbox.
    const keys = Array.from({ length: 5 }, () => emailIdempotencyKey(NOTIFICATION_ID));
    expect(new Set(keys).size).toBe(1);
  });

  it('differs between notifications', () => {
    expect(emailIdempotencyKey(NOTIFICATION_ID)).not.toBe(
      emailIdempotencyKey('22222222-2222-4222-8222-000000000002'),
    );
  });

  it('contains no email address, user id or secret', () => {
    // It travels in a header to a third party and is echoed in their
    // dashboards. Nothing personal belongs in it.
    const key = emailIdempotencyKey(NOTIFICATION_ID);

    expect(key).not.toContain('@');
    expect(key).not.toContain(CONFIG.apiKey);
    expect(key).toBe(`matchday/notification/${NOTIFICATION_ID}/email/v1`);
  });

  it('is versioned, so content that should legitimately re-send can', () => {
    expect(emailIdempotencyKey(NOTIFICATION_ID)).toMatch(/\/v1$/);
  });

  it('stays within a bounded length', () => {
    expect(emailIdempotencyKey(NOTIFICATION_ID).length).toBeLessThanOrEqual(128);
  });
});

describe('sending', () => {
  it('posts to Resend with the key in the Idempotency-Key header', async () => {
    const { transport, requests } = createTransport({ status: 200, json: { id: 'abc123' } });

    await createResendSender(CONFIG, transport).send(message());

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.resend.com/emails');
    expect(requests[0]?.idempotencyKey).toBe(emailIdempotencyKey(NOTIFICATION_ID));
  });

  it('sends both an HTML and a plain-text part', async () => {
    const { transport, requests } = createTransport({ status: 200, json: { id: 'abc123' } });

    await createResendSender(CONFIG, transport).send(message());

    const body = requests[0]?.body as Record<string, unknown>;
    expect(body.html).toBe(RENDERED.html);
    expect(body.text).toBe(RENDERED.text);
    expect(body.subject).toBe(RENDERED.subject);
    expect(body.from).toBe(CONFIG.from);
    expect(body.to).toEqual(['player@example.test']);
  });

  it('captures the provider message id', async () => {
    const { transport } = createTransport({ status: 200, json: { id: 'resend-msg-0001' } });

    const outcome = await createResendSender(CONFIG, transport).send(message());

    expect(outcome).toEqual({ ok: true, providerMessageId: 'resend-msg-0001' });
  });

  it('still succeeds when the provider returns an id we cannot store', async () => {
    // The column has a shape constraint. An identifier that fails it degrades
    // to "no id recorded" rather than failing a delivery that actually worked.
    const { transport } = createTransport({ status: 200, json: { id: 'has spaces and £' } });

    expect(await createResendSender(CONFIG, transport).send(message())).toEqual({ ok: true });
  });

  it('still succeeds when the body is not JSON at all', async () => {
    const { transport } = createTransport({ status: 202, json: null });
    expect(await createResendSender(CONFIG, transport).send(message())).toEqual({ ok: true });
  });

  it('reports the status only, never the provider error body', async () => {
    // A Resend error body can quote the recipient address and the subject.
    const { transport } = createTransport({
      status: 422,
      json: { message: 'Invalid `to` field: player@example.test' },
    });

    const outcome = await createResendSender(CONFIG, transport).send(message());

    expect(outcome).toEqual({ ok: false, statusCode: 422 });
    expect(JSON.stringify(outcome)).not.toContain('player@example.test');
  });

  it('hands a transport throw on unmodified, and never logs it', async () => {
    const boom = Object.assign(new Error('socket hang up'), { name: 'TypeError' });
    const { transport } = createTransport(async () => {
      throw boom;
    });

    expect(await createResendSender(CONFIG, transport).send(message())).toEqual({
      ok: false,
      error: boom,
    });
  });

  it('never puts the API key anywhere but the transport call', async () => {
    const { transport, requests } = createTransport({ status: 200, json: { id: 'x' } });

    const outcome = await createResendSender(CONFIG, transport).send(message());

    expect(requests[0]?.apiKey).toBe(CONFIG.apiKey);
    expect(JSON.stringify(requests[0]?.body)).not.toContain(CONFIG.apiKey);
    expect(JSON.stringify(outcome)).not.toContain(CONFIG.apiKey);
  });
});

describe('readEmailConfiguration', () => {
  const ORIGINAL_KEY = process.env.RESEND_API_KEY;
  const ORIGINAL_FROM = process.env.EMAIL_FROM;

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = ORIGINAL_KEY;
    if (ORIGINAL_FROM === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = ORIGINAL_FROM;
  });

  it('returns null when nothing is configured, rather than throwing', () => {
    // A deployment without email must start, serve and deliver push exactly as
    // before. Email is the only thing missing, and it is missing quietly.
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;

    expect(readEmailConfiguration()).toBeNull();
  });

  it.each([
    ['only a key', { RESEND_API_KEY: 'k', EMAIL_FROM: undefined }],
    ['only a from', { RESEND_API_KEY: undefined, EMAIL_FROM: 'a@b.test' }],
    ['blank values', { RESEND_API_KEY: '   ', EMAIL_FROM: '  ' }],
  ])('returns null for %s', (_label, env) => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    if (env.RESEND_API_KEY !== undefined) process.env.RESEND_API_KEY = env.RESEND_API_KEY;
    if (env.EMAIL_FROM !== undefined) process.env.EMAIL_FROM = env.EMAIL_FROM;

    expect(readEmailConfiguration()).toBeNull();
  });

  it('returns both values when both are set', () => {
    process.env.RESEND_API_KEY = ' key-with-space ';
    process.env.EMAIL_FROM = ' MatchDay <a@b.test> ';

    expect(readEmailConfiguration()).toEqual({
      apiKey: 'key-with-space',
      from: 'MatchDay <a@b.test>',
    });
  });
});

describe('the provider error name', () => {
  it('is extracted so the two 409s can be told apart', async () => {
    const { transport } = createTransport({
      status: 409,
      json: { name: 'concurrent_idempotent_requests', message: 'still processing' },
    });

    expect(await createResendSender(CONFIG, transport).send(message())).toEqual({
      ok: false,
      statusCode: 409,
      providerErrorName: 'concurrent_idempotent_requests',
    });
  });

  it('reads a nested error object too', async () => {
    const { transport } = createTransport({
      status: 409,
      json: { error: { name: 'invalid_idempotent_request' } },
    });

    const outcome = await createResendSender(CONFIG, transport).send(message());
    expect(outcome).toMatchObject({ providerErrorName: 'invalid_idempotent_request' });
  });

  it('still carries no message, address or subject', async () => {
    const { transport } = createTransport({
      status: 409,
      json: {
        name: 'invalid_idempotent_request',
        message: 'payload differs for player@example.test — subject "New match"',
      },
    });

    const outcome = await createResendSender(CONFIG, transport).send(message());

    expect(JSON.stringify(outcome)).not.toContain('player@example.test');
    expect(JSON.stringify(outcome)).not.toContain('New match');
    expect(JSON.stringify(outcome)).not.toContain('payload differs');
  });

  it('ignores a name that is not a short machine token', async () => {
    // A provider change must not turn this into a channel for arbitrary text.
    const { transport } = createTransport({
      status: 409,
      json: { name: 'Something With Spaces And <html>' },
    });

    expect(await createResendSender(CONFIG, transport).send(message())).toEqual({
      ok: false,
      statusCode: 409,
    });
  });

  it('omits the field entirely when the body has no name', async () => {
    const { transport } = createTransport({ status: 500, json: { message: 'boom' } });
    expect(await createResendSender(CONFIG, transport).send(message())).toEqual({
      ok: false,
      statusCode: 500,
    });
  });
});

describe('the request payload is deterministic', () => {
  it('contains no timestamp, nonce or generated identifier', async () => {
    // Resend suppresses a duplicate only when the payload matches byte for
    // byte. Anything varying per attempt would defeat the idempotency key.
    const { transport, requests } = createTransport({ status: 200, json: { id: 'x' } });
    const sender = createResendSender(CONFIG, transport);

    await sender.send(message());
    await sender.send(message());

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0]?.body)).toBe(JSON.stringify(requests[1]?.body));
    expect(requests[0]?.idempotencyKey).toBe(requests[1]?.idempotencyKey);

    // And the exact field set — a new field added later must be a deliberate act.
    expect(Object.keys(requests[0]?.body as object).sort()).toEqual([
      'from',
      'html',
      'subject',
      'text',
      'to',
    ]);
  });
});

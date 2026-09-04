import { describe, expect, it } from 'vitest';
import {
  dispatchEmailNotifications,
  payloadFingerprint,
  type EmailDispatchNotification,
  type EmailDispatchStore,
} from '@/lib/email/dispatch';
import { renderNotificationEmail } from '@/lib/email/template';
import { emailIdempotencyKey, type EmailSender } from '@/lib/email/resend';
import type { EmailDeliveryStatus, NotificationType } from '@/types/database';

/**
 * The email channel, decided without a provider or a database.
 *
 * The interesting cases are the no-ops. An email that is not owed must produce
 * no attempt row, no provider call and — above all — no retry work, because
 * Phase 3C would otherwise back off five times waiting for an address to
 * appear that nobody is going to add.
 */

const ID = '11111111-1111-4111-8111-000000000001';
const BASE_URL = 'https://app.matchdayapps.com';
const FROM = 'MatchDay <notifications@example.test>';

/** Exactly what the dispatcher will render for a notification. */
function renderedFor(n: EmailDispatchNotification) {
  return renderNotificationEmail({
    title: n.title,
    body: n.body,
    url: `${BASE_URL}${n.deep_link}`,
    settingsUrl: `${BASE_URL}/settings/notifications`,
  });
}

function notification(overrides: Partial<EmailDispatchNotification> = {}) {
  return {
    id: ID,
    type: 'match_published' as NotificationType,
    title: 'New match: Monday night 11v11',
    body: 'Mon 17 Aug 19:00 at RMV Community Pitch',
    deep_link: '/leagues/rmv/matches/abc',
    ...overrides,
  };
}

function createStore(
  overrides: Partial<EmailDispatchStore> & { notifications?: EmailDispatchNotification[] } = {},
) {
  const recorded: Array<{
    notificationId: string;
    status: EmailDeliveryStatus;
    errorCategory: string | null;
    providerMessageId: string | null;
    fingerprint: string | null;
  }> = [];

  const store: EmailDispatchStore = {
    loadNotifications: async () => overrides.notifications ?? [notification()],
    resolveRecipient: async () => 'player@example.test',
    loadAttempt: async () => null,
    recordResult: async (notificationId, status, errorCategory, providerMessageId, fingerprint) => {
      recorded.push({
        notificationId,
        status,
        errorCategory,
        providerMessageId: providerMessageId ?? null,
        fingerprint: fingerprint ?? null,
      });
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'notifications')),
  } as EmailDispatchStore;

  return { store, recorded };
}

function senderReplying(outcome: Awaited<ReturnType<EmailSender['send']>>) {
  const sent: Array<{ to: string; idempotencyKey: string; subject: string }> = [];
  const sender: EmailSender = {
    send: async (message) => {
      sent.push({
        to: message.to,
        idempotencyKey: message.idempotencyKey,
        subject: message.rendered.subject,
      });
      return outcome;
    },
  };
  return { sender, sent };
}

describe('when email is owed', () => {
  it('sends once and records it as sent', async () => {
    const { store, recorded } = createStore();
    const { sender, sent } = senderReplying({ ok: true, providerMessageId: 'resend-1' });

    const result = await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL, from: FROM });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('player@example.test');
    expect(sent[0]?.idempotencyKey).toBe(emailIdempotencyKey(ID));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      notificationId: ID,
      status: 'sent',
      errorCategory: null,
      providerMessageId: 'resend-1',
    });
    // The fingerprint of what we asked Resend to send, recorded alongside it.
    expect(recorded[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result).toMatchObject({ attempted: 1, sent: 1, failed: 0, retryable: 0 });
  });
});

describe('the no-ops — none of which may create retry work', () => {
  it.each([
    ['the switch is off / no confirmed address', { resolveRecipient: async () => null }],
    [
      'the email already reached a terminal state',
      { loadAttempt: async () => ({ settled: true, payloadFingerprint: null }) },
    ],
  ])('skips when %s', async (_label, override) => {
    const { store, recorded } = createStore(override as Partial<EmailDispatchStore>);
    const { sender, sent } = senderReplying({ ok: true });

    const result = await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL, from: FROM });

    expect(sent).toHaveLength(0);
    expect(recorded).toHaveLength(0);
    expect(result).toMatchObject({ attempted: 0, sent: 0, failed: 0, retryable: 0, skipped: 1 });
  });

  it('skips a notification type that is not eligible for external delivery', async () => {
    // `attendance_recorded` is the one whose body can say "you are recorded as
    // not having attended". It stays out of an inbox as well as off a lock
    // screen — the same list decides both.
    const { store, recorded } = createStore({
      notifications: [notification({ type: 'attendance_recorded' })],
    });
    const { sender, sent } = senderReplying({ ok: true });

    const result = await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL, from: FROM });

    expect(sent).toHaveLength(0);
    expect(recorded).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it('skips everything when this deployment has no email transport', async () => {
    const { store, recorded } = createStore();

    const result = await dispatchEmailNotifications([ID], {
      store,
      sender: null,
      baseUrl: BASE_URL,
      from: FROM,
    });

    expect(recorded).toHaveLength(0);
    expect(result).toMatchObject({ attempted: 0, retryable: 0, skipped: 1 });
  });

  it('does nothing at all for an empty batch', async () => {
    const { store } = createStore();
    const { sender } = senderReplying({ ok: true });

    expect(await dispatchEmailNotifications([], { store, sender, baseUrl: BASE_URL, from: FROM })).toEqual({
      attempted: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      retryable: 0,
      aborted: false,
    });
  });
});

describe('failures', () => {
  it('counts a temporary failure as retryable', async () => {
    const { store, recorded } = createStore();
    const { sender } = senderReplying({ ok: false, statusCode: 429 });

    const result = await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL, from: FROM });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      notificationId: ID,
      status: 'temporary_failure',
      errorCategory: 'rate_limited',
      providerMessageId: null,
    });
    expect(result).toMatchObject({ attempted: 1, failed: 1, retryable: 1 });
  });

  it('does NOT count a permanent failure as retryable', async () => {
    const { store, recorded } = createStore();
    const { sender } = senderReplying({ ok: false, statusCode: 403 });

    const result = await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL, from: FROM });

    expect(recorded[0]).toMatchObject({
      status: 'permanent_failure',
      errorCategory: 'unauthorized',
    });
    expect(result).toMatchObject({ attempted: 1, failed: 1, retryable: 0 });
  });

  it('treats a transport throw as retryable', async () => {
    const { store, recorded } = createStore();
    const { sender } = senderReplying({ ok: false, error: new Error('ECONNRESET') });

    const result = await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL, from: FROM });

    expect(recorded[0]).toMatchObject({ status: 'temporary_failure', errorCategory: 'network' });
    expect(result.retryable).toBe(1);
  });

  it('records a malformed deep link permanently rather than retrying a column', async () => {
    const { store, recorded } = createStore({
      notifications: [notification({ deep_link: '//evil.test' })],
    });
    const { sender, sent } = senderReplying({ ok: true });

    const result = await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL, from: FROM });

    expect(sent).toHaveLength(0);
    expect(recorded[0]).toMatchObject({
      status: 'permanent_failure',
      errorCategory: 'invalid_link',
    });
    expect(result.retryable).toBe(0);
  });

  it('reports an aborted pass rather than pretending there was nothing to do', async () => {
    // The store died mid-pass. Reporting `attempted: 0` alone would be
    // indistinguishable from "nobody wanted an email" — the exact ambiguity
    // Phase 3B added `aborted` to remove.
    const { store } = createStore({
      resolveRecipient: async () => {
        throw new Error('database went away');
      },
    });
    const { sender } = senderReplying({ ok: true });

    const result = await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL, from: FROM });

    expect(result.aborted).toBe(true);
  });

  it('never lets a provider error object reach the caller', async () => {
    const { store } = createStore({
      resolveRecipient: async () => {
        throw new Error('contains player@example.test somehow');
      },
    });
    const { sender } = senderReplying({ ok: true });

    const result = await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL, from: FROM });

    expect(JSON.stringify(result)).not.toContain('player@example.test');
  });
});

describe('what the provider is asked to send', () => {
  it('escapes hostile notification text before it reaches the message', async () => {
    const hostile = '<script>alert(1)</script>';
    const { store } = createStore({
      notifications: [notification({ title: hostile, body: hostile })],
    });
    const captured: string[] = [];
    const sender: EmailSender = {
      send: async (message) => {
        captured.push(message.rendered.html);
        return { ok: true };
      },
    };

    await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL, from: FROM });

    expect(captured[0]).not.toContain('<script');
    expect(captured[0]).toContain('&lt;script&gt;');
  });

  it('builds absolute HTTPS links from the deployment base URL', async () => {
    const { store } = createStore();
    const captured: string[] = [];
    const sender: EmailSender = {
      send: async (message) => {
        captured.push(message.rendered.text);
        return { ok: true };
      },
    };

    await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL, from: FROM });

    expect(captured[0]).toContain('https://app.matchdayapps.com/leagues/rmv/matches/abc');
    expect(captured[0]).toContain('https://app.matchdayapps.com/settings/notifications');
  });
});

describe('the payload must match the idempotency key', () => {
  /**
   * Resend suppresses a duplicate only when the idempotency key AND the request
   * payload both match. Our key is stable by construction; the payload is not —
   * `to` is resolved from `auth.users` on every worker pass, and somebody can
   * confirm a new address between the first attempt and the retry.
   *
   * Sending the old key with the new payload earns a 409
   * `invalid_idempotent_request`. Minting a NEW key would be worse: if the
   * original request reached Resend and only our response was lost, that is a
   * second email.
   */
  function storeWith(state: { settled: boolean; payloadFingerprint: string | null } | null) {
    const recorded: Array<{
      status: EmailDeliveryStatus;
      errorCategory: string | null;
      fingerprint: string | null;
    }> = [];

    const store: EmailDispatchStore = {
      loadNotifications: async () => [notification()],
      resolveRecipient: async () => 'player@example.test',
      loadAttempt: async () => state,
      recordResult: async (_id, status, errorCategory, _pid, fingerprint) => {
        recorded.push({ status, errorCategory, fingerprint: fingerprint ?? null });
      },
    };

    return { store, recorded };
  }

  it('is deterministic — the same inputs fingerprint identically', () => {
    const input = {
      from: FROM,
      to: 'player@example.test',
      subject: 'S',
      html: '<p>H</p>',
      text: 'T',
    };

    expect(payloadFingerprint(input)).toBe(payloadFingerprint(input));
    expect(payloadFingerprint(input)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['recipient', { to: 'someone-else@example.test' }],
    ['from address', { from: 'MatchDay <other@example.test>' }],
    ['subject', { subject: 'different' }],
    ['html', { html: '<p>different</p>' }],
    ['text', { text: 'different' }],
  ])('changes when the %s changes', (_label, override) => {
    const base = {
      from: FROM,
      to: 'player@example.test',
      subject: 'S',
      html: '<p>H</p>',
      text: 'T',
    };

    expect(payloadFingerprint({ ...base, ...override })).not.toBe(payloadFingerprint(base));
  });

  it('cannot be collided by moving a field boundary', () => {
    // A naive concatenation would make ("ab","c") and ("a","bc") identical.
    const a = { from: 'ab', to: 'c', subject: '', html: '', text: '' };
    const b = { from: 'a', to: 'bc', subject: '', html: '', text: '' };

    expect(payloadFingerprint(a)).not.toBe(payloadFingerprint(b));
  });

  it('records the fingerprint on the first real provider request', async () => {
    const { store, recorded } = storeWith(null);
    const { sender } = senderReplying({ ok: true, providerMessageId: 'r' });

    await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL, from: FROM });

    expect(recorded[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records it on a FAILED request too — the key was still consumed', async () => {
    const { store, recorded } = storeWith(null);
    const { sender } = senderReplying({ ok: false, statusCode: 429 });

    await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL, from: FROM });

    expect(recorded[0]?.status).toBe('temporary_failure');
    expect(recorded[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('retries normally when the payload is unchanged', async () => {
    const unchanged = payloadFingerprint({
      from: FROM,
      to: 'player@example.test',
      subject: renderedFor(notification()).subject,
      html: renderedFor(notification()).html,
      text: renderedFor(notification()).text,
    });
    const { store } = storeWith({ settled: false, payloadFingerprint: unchanged });
    const { sender, sent } = senderReplying({ ok: true });

    const result = await dispatchEmailNotifications([ID], {
      store,
      sender,
      baseUrl: BASE_URL,
      from: FROM,
    });

    expect(sent).toHaveLength(1);
    expect(result.sent).toBe(1);
  });

  it('does NOT call Resend when the payload changed under the same key', async () => {
    // THE GUARD. A different fingerprint means the recipient — or the
    // from-address, or the rendered content — moved between attempts.
    const { store, recorded } = storeWith({
      settled: false,
      payloadFingerprint: 'f'.repeat(64),
    });
    const { sender, sent } = senderReplying({ ok: true });

    const result = await dispatchEmailNotifications([ID], {
      store,
      sender,
      baseUrl: BASE_URL,
      from: FROM,
    });

    expect(sent).toHaveLength(0);
    expect(recorded).toEqual([
      {
        status: 'permanent_failure',
        errorCategory: 'idempotency_payload_changed',
        fingerprint: null,
      },
    ]);
    // Terminal, not retryable: waiting will not make the old payload come back.
    expect(result).toMatchObject({ attempted: 1, failed: 1, retryable: 0, sent: 0 });
  });

  it('mints no new idempotency key when the payload changed', async () => {
    // A fresh key would send a second email if the original request actually
    // reached Resend and only our response was lost.
    const { store } = storeWith({ settled: false, payloadFingerprint: 'a'.repeat(64) });
    const keys: string[] = [];
    const sender: EmailSender = {
      send: async (message) => {
        keys.push(message.idempotencyKey);
        return { ok: true };
      },
    };

    await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL, from: FROM });

    expect(keys).toEqual([]);
  });

  it('stores a hash and nothing else — no address, no content', async () => {
    const { store, recorded } = storeWith(null);
    const { sender } = senderReplying({ ok: true });

    await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL, from: FROM });

    const fingerprint = recorded[0]?.fingerprint ?? '';
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toContain('@');
    expect(fingerprint).not.toContain('player');
    expect(fingerprint).not.toContain('Monday');
  });
});

describe('Resend 409s mean two different things', () => {
  function store() {
    const recorded: Array<{ status: EmailDeliveryStatus; errorCategory: string | null }> = [];
    const s: EmailDispatchStore = {
      loadNotifications: async () => [notification()],
      resolveRecipient: async () => 'player@example.test',
      loadAttempt: async () => null,
      recordResult: async (_id, status, errorCategory) => {
        recorded.push({ status, errorCategory });
      },
    };
    return { store: s, recorded };
  }

  it('concurrent_idempotent_requests is RETRYABLE', async () => {
    // Another request with this key is still in flight. Nothing is wrong; the
    // 3C ladder is exactly the right way to come back.
    const { store: s, recorded } = store();
    const { sender } = senderReplying({
      ok: false,
      statusCode: 409,
      providerErrorName: 'concurrent_idempotent_requests',
    });

    const result = await dispatchEmailNotifications([ID], {
      store: s,
      sender,
      baseUrl: BASE_URL,
      from: FROM,
    });

    expect(recorded[0]).toEqual({
      status: 'temporary_failure',
      errorCategory: 'concurrent_request',
    });
    expect(result.retryable).toBe(1);
  });

  it('invalid_idempotent_request is PERMANENT', async () => {
    // The key was already used with a different payload. Retrying sends the
    // same contradiction again.
    const { store: s, recorded } = store();
    const { sender } = senderReplying({
      ok: false,
      statusCode: 409,
      providerErrorName: 'invalid_idempotent_request',
    });

    const result = await dispatchEmailNotifications([ID], {
      store: s,
      sender,
      baseUrl: BASE_URL,
      from: FROM,
    });

    expect(recorded[0]).toEqual({
      status: 'permanent_failure',
      errorCategory: 'idempotency_mismatch',
    });
    expect(result.retryable).toBe(0);
  });

  it('an unnamed 409 is treated as the retryable case', async () => {
    const { store: s, recorded } = store();
    const { sender } = senderReplying({ ok: false, statusCode: 409 });

    const result = await dispatchEmailNotifications([ID], {
      store: s,
      sender,
      baseUrl: BASE_URL,
      from: FROM,
    });

    expect(recorded[0]?.status).toBe('temporary_failure');
    expect(result.retryable).toBe(1);
  });
});

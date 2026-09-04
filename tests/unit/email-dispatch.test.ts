import { describe, expect, it } from 'vitest';
import {
  dispatchEmailNotifications,
  type EmailDispatchNotification,
  type EmailDispatchStore,
} from '@/lib/email/dispatch';
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
  }> = [];

  const store: EmailDispatchStore = {
    loadNotifications: async () => overrides.notifications ?? [notification()],
    resolveRecipient: async () => 'player@example.test',
    alreadySettled: async () => false,
    recordResult: async (notificationId, status, errorCategory, providerMessageId) => {
      recorded.push({
        notificationId,
        status,
        errorCategory,
        providerMessageId: providerMessageId ?? null,
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

    const result = await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('player@example.test');
    expect(sent[0]?.idempotencyKey).toBe(emailIdempotencyKey(ID));
    expect(recorded).toEqual([
      { notificationId: ID, status: 'sent', errorCategory: null, providerMessageId: 'resend-1' },
    ]);
    expect(result).toMatchObject({ attempted: 1, sent: 1, failed: 0, retryable: 0 });
  });
});

describe('the no-ops — none of which may create retry work', () => {
  it.each([
    ['the switch is off / no confirmed address', { resolveRecipient: async () => null }],
    ['the email already reached a terminal state', { alreadySettled: async () => true }],
  ])('skips when %s', async (_label, override) => {
    const { store, recorded } = createStore(override as Partial<EmailDispatchStore>);
    const { sender, sent } = senderReplying({ ok: true });

    const result = await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL });

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

    const result = await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL });

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
    });

    expect(recorded).toHaveLength(0);
    expect(result).toMatchObject({ attempted: 0, retryable: 0, skipped: 1 });
  });

  it('does nothing at all for an empty batch', async () => {
    const { store } = createStore();
    const { sender } = senderReplying({ ok: true });

    expect(await dispatchEmailNotifications([], { store, sender, baseUrl: BASE_URL })).toEqual({
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

    const result = await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL });

    expect(recorded).toEqual([
      {
        notificationId: ID,
        status: 'temporary_failure',
        errorCategory: 'rate_limited',
        providerMessageId: null,
      },
    ]);
    expect(result).toMatchObject({ attempted: 1, failed: 1, retryable: 1 });
  });

  it('does NOT count a permanent failure as retryable', async () => {
    const { store, recorded } = createStore();
    const { sender } = senderReplying({ ok: false, statusCode: 403 });

    const result = await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL });

    expect(recorded[0]).toMatchObject({
      status: 'permanent_failure',
      errorCategory: 'unauthorized',
    });
    expect(result).toMatchObject({ attempted: 1, failed: 1, retryable: 0 });
  });

  it('treats a transport throw as retryable', async () => {
    const { store, recorded } = createStore();
    const { sender } = senderReplying({ ok: false, error: new Error('ECONNRESET') });

    const result = await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL });

    expect(recorded[0]).toMatchObject({ status: 'temporary_failure', errorCategory: 'network' });
    expect(result.retryable).toBe(1);
  });

  it('records a malformed deep link permanently rather than retrying a column', async () => {
    const { store, recorded } = createStore({
      notifications: [notification({ deep_link: '//evil.test' })],
    });
    const { sender, sent } = senderReplying({ ok: true });

    const result = await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL });

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

    const result = await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL });

    expect(result.aborted).toBe(true);
  });

  it('never lets a provider error object reach the caller', async () => {
    const { store } = createStore({
      resolveRecipient: async () => {
        throw new Error('contains player@example.test somehow');
      },
    });
    const { sender } = senderReplying({ ok: true });

    const result = await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL });

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

    await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL });

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

    await dispatchEmailNotifications([ID], { store, sender, baseUrl: BASE_URL });

    expect(captured[0]).toContain('https://app.matchdayapps.com/leagues/rmv/matches/abc');
    expect(captured[0]).toContain('https://app.matchdayapps.com/settings/notifications');
  });
});

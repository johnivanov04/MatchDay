import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchPushNotifications,
  type PushDispatchStore,
  type PushSubscriptionRecord,
} from '@/lib/push/dispatch';
import type { CanonicalNotificationForPush } from '@/lib/push/payload';
import type { PushSender } from '@/lib/push/sender';
import type { PushDeliveryStatus } from '@/types/database';

/**
 * Delivery orchestration, with both the store and the sender injected.
 *
 * No test here performs a network call. That is the point of the seam: the
 * decisions worth testing — eligibility, idempotency, failure classification,
 * and above all that a push failure never propagates — are all above it.
 */

const NOTIFICATION: CanonicalNotificationForPush = {
  id: 'notification-1',
  type: 'match_published',
  title: 'New match',
  body: 'Mon 19:00',
  deep_link: '/leagues/x/matches/y',
};

const SUBSCRIPTION: PushSubscriptionRecord = {
  id: 'subscription-1',
  user_id: 'user-1',
  endpoint: 'https://push.example.test/aaa',
  p256dh: 'key',
  auth_secret: 'secret',
};

interface Recorded {
  notificationId: string;
  subscriptionId: string;
  status: PushDeliveryStatus;
  errorCategory: string | null;
}

function createStore(overrides: Partial<PushDispatchStore> = {}) {
  const recorded: Recorded[] = [];
  const delivered = new Set<string>();

  const store: PushDispatchStore = {
    loadNotifications: async () => [NOTIFICATION],
    loadRecipients: async () => new Map([[NOTIFICATION.id, SUBSCRIPTION.user_id]]),
    loadEnabledSubscriptions: async () => [SUBSCRIPTION],
    alreadyDelivered: async (notificationId, subscriptionId) =>
      delivered.has(`${notificationId}:${subscriptionId}`),
    recordResult: async (notificationId, subscriptionId, status, errorCategory) => {
      recorded.push({ notificationId, subscriptionId, status, errorCategory });
      if (status === 'sent' || status === 'permanent_failure' || status === 'invalidated') {
        delivered.add(`${notificationId}:${subscriptionId}`);
      }
    },
    ...overrides,
  };

  return { store, recorded, delivered };
}

const succeedingSender: PushSender = { send: async () => ({ ok: true }) };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('successful delivery', () => {
  it('sends one push per enabled device and records it', async () => {
    const { store, recorded } = createStore();
    const result = await dispatchPushNotifications([NOTIFICATION.id], {
      store,
      sender: succeedingSender,
    });

    expect(result).toMatchObject({ attempted: 1, sent: 1, failed: 0 });
    expect(recorded).toEqual([
      {
        notificationId: NOTIFICATION.id,
        subscriptionId: SUBSCRIPTION.id,
        status: 'sent',
        errorCategory: null,
      },
    ]);
  });

  it('sends to every device a person has registered', async () => {
    const second = { ...SUBSCRIPTION, id: 'subscription-2', endpoint: 'https://push.example.test/bbb' };
    const { store } = createStore({
      loadEnabledSubscriptions: async () => [SUBSCRIPTION, second],
    });

    const send = vi.fn<PushSender['send']>().mockResolvedValue({ ok: true });
    const result = await dispatchPushNotifications([NOTIFICATION.id], {
      store,
      sender: { send },
    });

    expect(result.sent).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('passes only the four payload fields to the sender', async () => {
    const { store } = createStore();
    const send = vi.fn<PushSender['send']>().mockResolvedValue({ ok: true });

    await dispatchPushNotifications([NOTIFICATION.id], { store, sender: { send } });

    const payload = send.mock.calls[0]?.[1];
    expect(Object.keys(payload ?? {}).sort()).toEqual([
      'body',
      'notificationId',
      'title',
      'url',
    ]);
  });
});

describe('idempotency', () => {
  it('does not send twice for the same notification and device', async () => {
    const { store } = createStore();
    const send = vi.fn<PushSender['send']>().mockResolvedValue({ ok: true });

    await dispatchPushNotifications([NOTIFICATION.id], { store, sender: { send } });
    await dispatchPushNotifications([NOTIFICATION.id], { store, sender: { send } });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does retry after a temporary failure', async () => {
    const { store } = createStore();
    const send = vi
      .fn<PushSender['send']>()
      .mockResolvedValueOnce({ ok: false, statusCode: 503 })
      .mockResolvedValueOnce({ ok: true });

    await dispatchPushNotifications([NOTIFICATION.id], { store, sender: { send } });
    await dispatchPushNotifications([NOTIFICATION.id], { store, sender: { send } });

    // A temporary failure is not terminal — that is the whole distinction.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not retry after a permanent failure', async () => {
    const { store } = createStore();
    const send = vi.fn<PushSender['send']>().mockResolvedValue({ ok: false, statusCode: 403 });

    await dispatchPushNotifications([NOTIFICATION.id], { store, sender: { send } });
    await dispatchPushNotifications([NOTIFICATION.id], { store, sender: { send } });

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('failure classification is persisted', () => {
  it.each([
    [410, 'invalidated', 'gone'],
    [404, 'invalidated', 'not_found'],
    [403, 'permanent_failure', 'unauthorized'],
    [503, 'temporary_failure', 'server_error'],
    [429, 'temporary_failure', 'rate_limited'],
  ])('records %i as %s/%s', async (statusCode, status, category) => {
    const { store, recorded } = createStore();
    await dispatchPushNotifications([NOTIFICATION.id], {
      store,
      sender: { send: async () => ({ ok: false, statusCode: statusCode as number }) },
    });

    expect(recorded[0]).toMatchObject({ status, errorCategory: category });
  });

  it('records a thrown error without storing its text', async () => {
    const { store, recorded } = createStore();
    await dispatchPushNotifications([NOTIFICATION.id], {
      store,
      sender: {
        send: async () => ({
          ok: false,
          error: new Error('failed talking to https://push.example.test/secret'),
        }),
      },
    });

    expect(recorded[0]?.errorCategory).toBe('network');
    expect(JSON.stringify(recorded)).not.toContain('push.example.test/secret');
  });
});

describe('push never breaks anything', () => {
  it('reports skipped rather than throwing when push is not configured', async () => {
    const { store, recorded } = createStore();
    const result = await dispatchPushNotifications([NOTIFICATION.id], { store, sender: null });

    // No VAPID keys: the canonical notification already exists, so nothing is
    // lost by simply not pushing.
    expect(result.skipped).toBe(1);
    expect(recorded).toEqual([]);
  });

  it('swallows a store failure instead of propagating it', async () => {
    const { store } = createStore({
      loadNotifications: async () => {
        throw new Error('database unavailable');
      },
    });

    await expect(
      dispatchPushNotifications([NOTIFICATION.id], { store, sender: succeedingSender }),
    ).resolves.toMatchObject({ sent: 0 });
  });

  it('swallows a sender that throws outright', async () => {
    const { store } = createStore();

    await expect(
      dispatchPushNotifications([NOTIFICATION.id], {
        store,
        sender: {
          send: async () => {
            throw new Error('boom');
          },
        },
      }),
    ).resolves.toBeDefined();
  });

  it('does nothing for an empty batch', async () => {
    const { store } = createStore();
    const result = await dispatchPushNotifications([], { store, sender: succeedingSender });
    expect(result).toEqual({ attempted: 0, sent: 0, failed: 0, skipped: 0 });
  });

  it('skips a notification whose type is not push-eligible', async () => {
    const { store, recorded } = createStore({
      loadNotifications: async () => [{ ...NOTIFICATION, type: 'join_request_submitted' }],
    });

    const result = await dispatchPushNotifications([NOTIFICATION.id], {
      store,
      sender: succeedingSender,
    });

    expect(result.skipped).toBe(1);
    expect(recorded).toEqual([]);
  });

  it('skips a notification with an unsafe deep link', async () => {
    const { store, recorded } = createStore({
      loadNotifications: async () => [{ ...NOTIFICATION, deep_link: 'https://evil.example' }],
    });

    await dispatchPushNotifications([NOTIFICATION.id], { store, sender: succeedingSender });
    expect(recorded).toEqual([]);
  });

  it('skips a recipient with no enabled devices', async () => {
    const { store, recorded } = createStore({ loadEnabledSubscriptions: async () => [] });

    const result = await dispatchPushNotifications([NOTIFICATION.id], {
      store,
      sender: succeedingSender,
    });

    expect(result.attempted).toBe(0);
    expect(recorded).toEqual([]);
  });

  it('sends only to the recipient’s own devices', async () => {
    const somebodyElse = { ...SUBSCRIPTION, id: 'other', user_id: 'user-2' };
    const { store } = createStore({
      loadEnabledSubscriptions: async () => [SUBSCRIPTION, somebodyElse],
    });

    const send = vi.fn<PushSender['send']>().mockResolvedValue({ ok: true });
    await dispatchPushNotifications([NOTIFICATION.id], { store, sender: { send } });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]?.subscriptionId).toBe(SUBSCRIPTION.id);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchPushNotifications,
  type PushDispatchStore,
  type PushSubscriptionRecord,
} from '@/lib/push/dispatch';
import type { CanonicalNotificationForPush } from '@/lib/push/payload';
import { createRoutingPushSender, type PushSender, type PushTarget } from '@/lib/push/sender';
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
  channel: 'web_push',
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

describe('two channels', () => {
  const APNS_SUBSCRIPTION: PushSubscriptionRecord = {
    id: 'subscription-apns',
    user_id: 'user-1',
    channel: 'apns',
    device_token: 'A1B2C3D4',
    apns_environment: 'production',
  };

  function createBothChannelStore() {
    return createStore({
      loadEnabledSubscriptions: async () => [SUBSCRIPTION, APNS_SUBSCRIPTION],
    });
  }

  it('addresses each device through the transport that speaks its protocol', async () => {
    const seen: PushTarget[] = [];
    const sender = createRoutingPushSender({
      web_push: {
        send: async (target) => {
          seen.push(target);
          return { ok: true };
        },
      },
      apns: {
        send: async (target) => {
          seen.push(target);
          return { ok: true };
        },
      },
    });

    const { store } = createBothChannelStore();
    const result = await dispatchPushNotifications([NOTIFICATION.id], { store, sender });

    expect(result).toMatchObject({ attempted: 2, sent: 2, failed: 0 });
    expect(seen).toEqual([
      {
        channel: 'web_push',
        subscriptionId: 'subscription-1',
        endpoint: SUBSCRIPTION.channel === 'web_push' ? SUBSCRIPTION.endpoint : '',
        p256dh: 'key',
        auth: 'secret',
      },
      {
        channel: 'apns',
        subscriptionId: 'subscription-apns',
        deviceToken: 'A1B2C3D4',
        environment: 'production',
      },
    ]);
  });

  describe('when one channel has no credentials configured', () => {
    /**
     * The state a deployment is in between shipping the iOS app and adding the
     * APNs key. Those sends must leave no trace: `permanent_failure` is
     * terminal for a (notification, subscription) pair, so recording one would
     * mean every notification sent during that window stays undeliverable
     * forever, even after the key is added.
     */
    it('skips its devices without recording anything against them', async () => {
      const { store, recorded } = createBothChannelStore();
      const sender = createRoutingPushSender({
        web_push: succeedingSender,
        apns: null,
      });

      const result = await dispatchPushNotifications([NOTIFICATION.id], { store, sender });

      expect(result).toMatchObject({ attempted: 1, sent: 1, failed: 0, skipped: 1 });
      expect(recorded.map((entry) => entry.subscriptionId)).toEqual(['subscription-1']);
    });

    it('still delivers to the other channel', async () => {
      const { store, recorded } = createBothChannelStore();
      const sender = createRoutingPushSender({ web_push: null, apns: succeedingSender });

      await dispatchPushNotifications([NOTIFICATION.id], { store, sender });

      expect(recorded).toEqual([
        {
          notificationId: NOTIFICATION.id,
          subscriptionId: 'subscription-apns',
          status: 'sent',
          errorCategory: null,
        },
      ]);
    });

    it('records nothing at all when neither is configured', async () => {
      const { store, recorded } = createBothChannelStore();
      const sender = createRoutingPushSender({ web_push: null, apns: null });

      const result = await dispatchPushNotifications([NOTIFICATION.id], { store, sender });

      expect(result).toMatchObject({ attempted: 0, sent: 0, failed: 0, skipped: 2 });
      expect(recorded).toEqual([]);
    });
  });

  describe('classifying what APNs said', () => {
    function senderReplying(apnsStatus: number, apnsReason: string | null): PushSender {
      return { send: async () => ({ ok: false, apnsStatus, apnsReason }) };
    }

    it('retires a device APNs says is unregistered', async () => {
      const { store, recorded } = createStore({
        loadEnabledSubscriptions: async () => [APNS_SUBSCRIPTION],
      });

      await dispatchPushNotifications([NOTIFICATION.id], {
        store,
        sender: createRoutingPushSender({
          web_push: null,
          apns: senderReplying(410, 'Unregistered'),
        }),
      });

      expect(recorded).toEqual([
        {
          notificationId: NOTIFICATION.id,
          subscriptionId: 'subscription-apns',
          status: 'invalidated',
          errorCategory: 'gone',
        },
      ]);
    });

    it('does not retire a device when our own signing key expired', async () => {
      // The whole reason the reason is carried alongside the status.
      const { store, recorded } = createStore({
        loadEnabledSubscriptions: async () => [APNS_SUBSCRIPTION],
      });

      await dispatchPushNotifications([NOTIFICATION.id], {
        store,
        sender: createRoutingPushSender({
          web_push: null,
          apns: senderReplying(403, 'ExpiredProviderToken'),
        }),
      });

      expect(recorded).toEqual([
        {
          notificationId: NOTIFICATION.id,
          subscriptionId: 'subscription-apns',
          status: 'permanent_failure',
          errorCategory: 'unauthorized',
        },
      ]);
    });

    it.each([
      ['DeviceTokenNotForTopic', 400, 'provider_config'],
      ['InvalidProviderToken', 403, 'unauthorized'],
      ['BadTopic', 400, 'provider_config'],
    ])(
      '%s records a permanent failure and leaves the device enabled',
      async (reason, status, category) => {
        /**
         * All three are configuration faults of ours. `record_push_delivery_result`
         * has no branch for `permanent_failure`, so the subscription row is
         * untouched — no `enabled = false`, no `disabled_reason` — and delivery
         * resumes the moment the configuration is fixed.
         */
        const { store, recorded } = createStore({
          loadEnabledSubscriptions: async () => [APNS_SUBSCRIPTION],
        });

        await dispatchPushNotifications([NOTIFICATION.id], {
          store,
          sender: createRoutingPushSender({
            web_push: null,
            apns: senderReplying(status, reason),
          }),
        });

        expect(recorded).toEqual([
          {
            notificationId: NOTIFICATION.id,
            subscriptionId: 'subscription-apns',
            status: 'permanent_failure',
            errorCategory: category,
          },
        ]);
      },
    );

    it.each([['Unregistered'], ['ExpiredToken'], ['BadDeviceToken']])(
      '%s is the kind that does retire the device',
      async (reason) => {
        const { store, recorded } = createStore({
          loadEnabledSubscriptions: async () => [APNS_SUBSCRIPTION],
        });

        await dispatchPushNotifications([NOTIFICATION.id], {
          store,
          sender: createRoutingPushSender({
            web_push: null,
            apns: senderReplying(410, reason),
          }),
        });

        expect(recorded[0]).toMatchObject({ status: 'invalidated' });
      },
    );

    it('retries a device APNs was merely too busy for', async () => {
      const { store, recorded } = createStore({
        loadEnabledSubscriptions: async () => [APNS_SUBSCRIPTION],
      });

      await dispatchPushNotifications([NOTIFICATION.id], {
        store,
        sender: createRoutingPushSender({
          web_push: null,
          apns: senderReplying(429, 'TooManyRequests'),
        }),
      });

      expect(recorded[0]).toMatchObject({
        status: 'temporary_failure',
        errorCategory: 'rate_limited',
      });
    });
  });
});

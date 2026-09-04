import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ObservabilityLog from '@/lib/observability/log';
import type { DeliveryQueueStore } from '@/lib/notifications/delivery-queue';
import type { PushDispatchStore, PushSubscriptionRecord } from '@/lib/push/dispatch';
import {
  createApnsSender,
  resetProviderTokenCache,
  type ApnsConfiguration,
} from '@/lib/push/apns';
import type { EmailDispatchStore } from '@/lib/email/dispatch';
import type { EmailSender } from '@/lib/email/resend';
import type { PushSender } from '@/lib/push/sender';
import type { ClaimedDeliveryJob, RescheduledDeliveryJob } from '@/types/database';

/**
 * The delivery worker's outcome contract.
 *
 * The dispatcher itself is already covered by `push-dispatch.test.ts`; what is
 * new in Phase 3B is everything *around* it — that work is claimed rather than
 * discovered, that every claimed job reaches a terminal state exactly once, and
 * that the queue is left in a state a later pass can recover from when this one
 * cannot finish.
 *
 * The most important assertions here are about what happens when things go
 * wrong, because a queue whose failure mode is "job silently disappears" is
 * worse than no queue at all: at least an inline dispatch failed loudly in
 * front of somebody.
 */

const mocks = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/observability/log', async (importOriginal) => ({
  ...(await importOriginal<typeof ObservabilityLog>()),
  logInfo: mocks.logInfo,
  logWarn: mocks.logWarn,
  logError: mocks.logError,
}));

const { runNotificationDelivery, deliveryRunFailed } = await import(
  '@/server/notification-delivery'
);

const NOTIFICATION = '22222222-2222-4222-8222-000000000001';

function job(index: number): ClaimedDeliveryJob {
  return {
    job_id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    job_notification_id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
    job_attempts: 1,
  };
}

/**
 * A queue that hands out `batches` in order and then reports empty.
 *
 * Records every claim and every terminal transition, so a test can assert on
 * what the worker did rather than on what it returned.
 */
function fakeQueue(batches: ClaimedDeliveryJob[][]) {
  const claims: Array<{ worker: string; limit: number; lease: number }> = [];
  const completed: string[] = [];
  const failed: Array<{ id: string; category: string | null }> = [];
  const rescheduled: Array<{ id: string; category: string | null }> = [];
  let call = 0;
  // Overridable per test so retry-budget behaviour can be simulated without a
  // database; the DB suite proves the real schedule.
  let rescheduleResult: RescheduledDeliveryJob = {
    outcome: 'scheduled',
    retry_number: 1,
    scheduled_for: '2026-09-02T12:00:00.000Z',
  };

  const queue: DeliveryQueueStore = {
    async claim(worker, limit, lease) {
      claims.push({ worker, limit, lease });
      return batches[call++] ?? [];
    },
    async complete(id) {
      completed.push(id);
      return true;
    },
    async fail(id, category) {
      failed.push({ id, category });
      return true;
    },
    async reschedule(id, category) {
      rescheduled.push({ id, category });
      return rescheduleResult;
    },
  };

  return {
    queue,
    claims,
    completed,
    failed,
    rescheduled,
    setRescheduleResult(next: RescheduledDeliveryJob) {
      rescheduleResult = next;
    },
  };
}

/** The dispatch layer is mocked at its own boundary, not below it. */
function deps(
  queue: DeliveryQueueStore,
  overrides: { store?: PushDispatchStore | null; sender?: PushSender | null } = {},
) {
  return {
    queue,
    store: overrides.store === undefined ? ({} as PushDispatchStore) : overrides.store,
    sender: overrides.sender === undefined ? ({ send: vi.fn() } as PushSender) : overrides.sender,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('claiming', () => {
  it('claims a bounded batch and drains until the queue is empty', async () => {
    const { queue, claims } = fakeQueue([[job(1), job(2)], [job(3)], []]);

    const result = await runNotificationDelivery({ deps: deps(queue), batchSize: 2 });

    expect(result.status).toBe('worked');
    expect(result.claimed).toBe(3);
    // Third claim returned nothing, which is what stopped the loop.
    expect(claims).toHaveLength(3);
    expect(claims[0]?.limit).toBe(2);
  });

  it('never asks for more than maxJobs in total', async () => {
    // Ten jobs available, but the pass is allowed three. The final claim asks
    // for exactly the remainder rather than a full batch.
    const { queue, claims } = fakeQueue([[job(1), job(2)], [job(3), job(4)]]);

    const result = await runNotificationDelivery({
      deps: deps(queue),
      batchSize: 2,
      maxJobs: 3,
    });

    expect(result.claimed).toBe(4);
    expect(claims.map((c) => c.limit)).toEqual([2, 1]);
  });

  it('reports an empty queue as idle rather than worked', async () => {
    // A distinguishability assertion, and the reason `runDueReminders` was
    // rewritten in Phase 5: "nothing to do" and "could not look" must never
    // produce the same result object.
    const { queue } = fakeQueue([[]]);

    const result = await runNotificationDelivery({ deps: deps(queue) });

    expect(result).toEqual({
      status: 'idle',
      claimed: 0,
      completed: 0,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
      sent: 0,
      mailSent: 0,
      errorCode: null,
    });
    expect(deliveryRunFailed(result)).toBe(false);
  });

  it('passes one opaque worker identity for the whole pass', async () => {
    const { queue, claims } = fakeQueue([[job(1)], [job(2)], []]);

    await runNotificationDelivery({ deps: deps(queue), batchSize: 1 });

    expect(new Set(claims.map((c) => c.worker)).size).toBe(1);
    // Never a hostname, a deployment URL or anything else infrastructural —
    // this value lands in a column operators read.
    expect(claims[0]?.worker).toMatch(/^w-[0-9a-f]{8}$/);
  });

  it('does not claim anything when there is nowhere to send', async () => {
    // A deployment with no transport leaves its jobs PENDING. Completing work
    // nothing could deliver would discard the notification the moment an
    // operator finally set the credentials.
    const { queue, claims, completed } = fakeQueue([[job(1)]]);

    const result = await runNotificationDelivery({ deps: deps(queue, { sender: null }) });

    expect(result.status).toBe('skipped');
    expect(claims).toHaveLength(0);
    expect(completed).toHaveLength(0);
    expect(mocks.logWarn).toHaveBeenCalledWith('notification_delivery.skipped', {
      service_role_configured: true,
      transport_configured: false,
    });
  });

  it('does not claim anything without a service-role key', async () => {
    const { queue, claims } = fakeQueue([[job(1)]]);

    const result = await runNotificationDelivery({ deps: deps(queue, { store: null }) });

    expect(result.status).toBe('skipped');
    expect(claims).toHaveLength(0);
  });
});

describe('dispatching', () => {
  it('sends the claimed notification through the existing dispatch layer', async () => {
    const send = vi.fn(async () => ({ ok: true as const, providerMessageId: 'abc' }));
    const store: PushDispatchStore = {
      loadNotifications: vi.fn(async () => [
        {
          id: NOTIFICATION,
          type: 'match_published' as const,
          title: 'New match',
          body: 'Mon 19:00',
          deep_link: '/leagues/x/matches/y',
        },
      ]),
      loadRecipients: vi.fn(async () => new Map([[NOTIFICATION, 'user-1']])),
      loadEnabledSubscriptions: vi.fn(async () => [
        {
          id: 'sub-1',
          user_id: 'user-1',
          channel: 'apns' as const,
          device_token: 'TOKEN',
          apns_environment: 'production' as const,
        },
      ]),
      alreadyDelivered: vi.fn(async () => false),
      recordResult: vi.fn(async () => undefined),
    };

    const { queue, completed } = fakeQueue([
      [{ job_id: 'job-1', job_notification_id: NOTIFICATION, job_attempts: 1 }],
      [],
    ]);

    const result = await runNotificationDelivery({
      deps: { queue, store, sender: { send } as unknown as PushSender },
    });

    // The real dispatcher ran: it loaded exactly the claimed notification and
    // recorded the outcome through the Phase 3A observability path.
    expect(store.loadNotifications).toHaveBeenCalledWith([NOTIFICATION]);
    expect(store.recordResult).toHaveBeenCalledWith(NOTIFICATION, 'sub-1', 'sent', null, 'abc');
    expect(result.sent).toBe(1);
    expect(completed).toEqual(['job-1']);
  });
});

describe('terminal state', () => {
  it('completes a job whose dispatch succeeded', async () => {
    const { queue, completed, failed } = fakeQueue([[job(1)], []]);
    const { store, sender } = scenario({ attempted: 2, sent: 2 });

    const result = await runNotificationDelivery({ deps: deps(queue, { store, sender }) });

    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(0);
    expect(result.completed).toBe(1);
  });

  it('completes a job with nothing to deliver to', async () => {
    // No enabled devices is a FINISHED job, not a failed one. Nothing is owed.
    const { queue, completed, failed } = fakeQueue([[job(1)], []]);
    const { store, sender } = scenario({ attempted: 0, sent: 0 });

    const result = await runNotificationDelivery({ deps: deps(queue, { store, sender }) });

    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(0);
    expect(result.completed).toBe(1);
  });

  it('completes a job that reached some devices and was permanently refused by others', async () => {
    // One member with a dead endpoint is an ordinary, successful fanout. The
    // per-device outcome is already on `push_delivery_attempts`; the job is
    // not the place to re-litigate it, and a permanent refusal earns no retry.
    const { queue, completed, failed, rescheduled } = fakeQueue([[job(1)], []]);
    const { store, sender } = scenario({ attempted: 3, sent: 1, failWith: 'permanent' });

    await runNotificationDelivery({ deps: deps(queue, { store, sender }) });

    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(0);
    expect(rescheduled).toHaveLength(0);
  });

  it('fails a job when every attempt it made was permanently rejected', async () => {
    const { queue, completed, failed } = fakeQueue([[job(1)], []]);
    const { store, sender } = scenario({ attempted: 2, sent: 0, failWith: 'permanent' });

    const result = await runNotificationDelivery({ deps: deps(queue, { store, sender }) });

    expect(completed).toHaveLength(0);
    expect(failed).toEqual([{ id: job(1).job_id, category: 'all_attempts_failed' }]);
    expect(result.failed).toBe(1);
    expect(mocks.logWarn).toHaveBeenCalledWith('notification_delivery.incomplete', {
      claimed: 1,
      failed: 1,
    });
  });

  it('leaves no job un-terminated when one notification blows up', async () => {
    // THE FAILURE THIS PREVENTS: one malformed notification taking down the
    // batch and leaving three perfectly deliverable jobs stuck in `processing`
    // until their leases expire.
    const store: PushDispatchStore = {
      loadNotifications: vi.fn(async (ids: string[]) => {
        if (ids[0] === job(2).job_notification_id) {
          throw new Error('boom');
        }
        return [];
      }),
      loadRecipients: vi.fn(async () => new Map()),
      loadEnabledSubscriptions: vi.fn(async () => []),
      alreadyDelivered: vi.fn(async () => false),
      recordResult: vi.fn(async () => undefined),
    };

    const { queue, completed, failed } = fakeQueue([[job(1), job(2), job(3)], []]);

    const result = await runNotificationDelivery({ deps: deps(queue, { store }) });

    expect(completed).toEqual([job(1).job_id, job(3).job_id]);
    expect(failed).toEqual([{ id: job(2).job_id, category: 'dispatch_error' }]);
    expect(result.claimed).toBe(3);
    expect(completed.length + failed.length).toBe(3);
  });

  it('fails a job whose dispatch gave up part way, rather than completing it', async () => {
    // THE SILENT-DROP REGRESSION, and the reason `PushDispatchResult.aborted`
    // exists at all.
    //
    // `dispatchPushNotifications` never throws — it catches internally and
    // returns whatever it managed. A store that dies half way through therefore
    // returns `{attempted: 0, sent: 0}`, which is byte-identical to "this
    // notification had no devices to send to". Read that as success and the job
    // is marked `completed`, the queue forgets it, and a notification nobody
    // received is gone for good.
    const { store, sender } = scenario({ attempted: 1, sent: 0 });
    store.loadEnabledSubscriptions = vi.fn(async () => {
      throw new Error('database went away');
    });

    const { queue, completed, failed } = fakeQueue([[job(1)], []]);

    const result = await runNotificationDelivery({ deps: { queue, store, sender } });

    expect(completed).toHaveLength(0);
    expect(failed).toEqual([{ id: job(1).job_id, category: 'dispatch_error' }]);
    expect(result.failed).toBe(1);
  });

  it('notes a job that something else had already finished', async () => {
    const { queue } = fakeQueue([[job(1)], []]);
    queue.complete = async () => false;

    await runNotificationDelivery({ deps: deps(queue, scenario({ attempted: 0, sent: 0 })) });

    expect(mocks.logWarn).toHaveBeenCalledWith('notification_delivery.stale_claim', {
      job_id: job(1).job_id,
    });
  });
});

describe('Phase 3C — retryable failures', () => {
  it('reschedules rather than completing when a provider says try later', async () => {
    const { queue, completed, failed, rescheduled } = fakeQueue([[job(1)], []]);
    const { store, sender } = scenario({ attempted: 1, sent: 0, failWith: 'temporary' });

    const result = await runNotificationDelivery({ deps: deps(queue, { store, sender }) });

    expect(rescheduled).toEqual([{ id: job(1).job_id, category: 'temporary_failure' }]);
    expect(completed).toHaveLength(0);
    expect(failed).toHaveLength(0);
    expect(result.rescheduled).toBe(1);
  });

  it('reschedules a PARTIAL fanout, even though something was delivered', async () => {
    // THE RULE THIS PHASE EXISTS FOR. One phone got it, another was rate
    // limited. Completing here would drop the second phone's copy for good.
    //
    // The already-sent pair is terminal in `push_delivery_attempts`, so the
    // retry re-sends to nobody who already has it — that half is proved
    // against the real database in `tests/db/notification-delivery-retry`.
    const { queue, completed, rescheduled } = fakeQueue([[job(1)], []]);
    const { store, sender } = scenario({ attempted: 2, sent: 1, failWith: 'temporary' });

    const result = await runNotificationDelivery({ deps: deps(queue, { store, sender }) });

    expect(rescheduled).toHaveLength(1);
    expect(completed).toHaveLength(0);
    // The successful send is still counted — it happened and is not undone.
    expect(result.sent).toBe(1);
  });

  it('logs the scheduled retry with its number and next attempt time', async () => {
    const f = fakeQueue([[job(1)], []]);
    f.setRescheduleResult({
      outcome: 'scheduled',
      retry_number: 3,
      scheduled_for: '2026-09-02T12:05:00.000Z',
    });
    const { store, sender } = scenario({ attempted: 1, sent: 0, failWith: 'temporary' });

    await runNotificationDelivery({ deps: deps(f.queue, { store, sender }) });

    expect(mocks.logInfo).toHaveBeenCalledWith('notification_delivery.retry_scheduled', {
      job_id: job(1).job_id,
      retry_number: 3,
      error_category: 'temporary_failure',
      next_attempt_at: '2026-09-02T12:05:00.000Z',
    });
  });

  it('counts an exhausted budget as a failed job and says so', async () => {
    const f = fakeQueue([[job(1)], []]);
    f.setRescheduleResult({ outcome: 'exhausted', retry_number: 5, scheduled_for: null });
    const { store, sender } = scenario({ attempted: 1, sent: 0, failWith: 'temporary' });

    const result = await runNotificationDelivery({ deps: deps(f.queue, { store, sender }) });

    expect(result.exhausted).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.rescheduled).toBe(0);
    expect(mocks.logWarn).toHaveBeenCalledWith('notification_delivery.retry_exhausted', {
      job_id: job(1).job_id,
      retry_number: 5,
      error_category: 'retries_exhausted',
    });
  });

  it('notes a reschedule the worker no longer had the right to make', async () => {
    const f = fakeQueue([[job(1)], []]);
    f.setRescheduleResult({ outcome: 'not_claimed', retry_number: null, scheduled_for: null });
    const { store, sender } = scenario({ attempted: 1, sent: 0, failWith: 'temporary' });

    await runNotificationDelivery({ deps: deps(f.queue, { store, sender }) });

    expect(mocks.logWarn).toHaveBeenCalledWith('notification_delivery.stale_claim', {
      job_id: job(1).job_id,
    });
  });

  it('never reschedules a permanent refusal', async () => {
    const { queue, rescheduled, failed } = fakeQueue([[job(1)], []]);
    const { store, sender } = scenario({ attempted: 2, sent: 0, failWith: 'permanent' });

    await runNotificationDelivery({ deps: deps(queue, { store, sender }) });

    expect(rescheduled).toHaveLength(0);
    expect(failed).toEqual([{ id: job(1).job_id, category: 'all_attempts_failed' }]);
  });

  it('never reschedules a notification with nothing to deliver to', async () => {
    // No enabled devices is a finished job. Waiting does not create a phone.
    const { queue, rescheduled, completed } = fakeQueue([[job(1)], []]);
    const { store, sender } = scenario({ attempted: 0, sent: 0 });

    await runNotificationDelivery({ deps: deps(queue, { store, sender }) });

    expect(rescheduled).toHaveLength(0);
    expect(completed).toHaveLength(1);
  });

  it('never reschedules an aborted dispatch — that is not a provider verdict', async () => {
    // The store died mid-pass. That is an internal fault, and spending a
    // provider retry on it would let a database blip drain the budget.
    const { store, sender } = scenario({ attempted: 1, sent: 0, failWith: 'temporary' });
    store.loadEnabledSubscriptions = vi.fn(async () => {
      throw new Error('database went away');
    });
    const { queue, rescheduled, failed } = fakeQueue([[job(1)], []]);

    await runNotificationDelivery({ deps: { queue, store, sender } });

    expect(rescheduled).toHaveLength(0);
    expect(failed).toEqual([{ id: job(1).job_id, category: 'dispatch_error' }]);
  });

  it('keeps processing the batch when one job is rescheduled', async () => {
    const { queue, completed, rescheduled } = fakeQueue([[job(1), job(2), job(3)], []]);
    let call = 0;
    const { store, sender } = scenario({ attempted: 1, sent: 0, failWith: 'temporary' });
    // Only the middle notification fails; the others have no devices.
    store.loadEnabledSubscriptions = vi.fn(async () =>
      call++ === 1
        ? [
            {
              id: 'sub-0',
              user_id: 'user-1',
              channel: 'apns' as const,
              device_token: 'TOKEN',
              apns_environment: 'production' as const,
            },
          ]
        : [],
    );

    const result = await runNotificationDelivery({ deps: { queue, store, sender } });

    expect(result.claimed).toBe(3);
    expect(completed).toHaveLength(2);
    expect(rescheduled).toHaveLength(1);
  });
});

describe('Phase 3C — a retry must not re-deliver what already arrived', () => {
  /**
   * A store that behaves like the real one across two worker passes.
   *
   * `alreadyDelivered` mirrors `push-store.ts` exactly — sent,
   * permanent_failure and invalidated are terminal; temporary_failure is not —
   * and `recordResult` keeps the state between passes. That is the whole
   * mechanism partial-fanout retry rests on, so it is worth reproducing rather
   * than stubbing.
   */
  function statefulStore(subscriptions: PushSubscriptionRecord[]) {
    const attempts = new Map<string, string>();

    const store: PushDispatchStore = {
      loadNotifications: async (ids) =>
        ids.map((id) => ({
          id,
          type: 'match_published' as const,
          title: 'New match',
          body: 'Mon 19:00',
          deep_link: '/leagues/x/matches/y',
        })),
      loadRecipients: async (ids) => new Map(ids.map((id) => [id, 'user-1'])),
      loadEnabledSubscriptions: async () => subscriptions,
      alreadyDelivered: async (notificationId, subscriptionId) => {
        const status = attempts.get(`${notificationId}:${subscriptionId}`);
        return status === 'sent' || status === 'permanent_failure' || status === 'invalidated';
      },
      recordResult: async (notificationId, subscriptionId, status) => {
        attempts.set(`${notificationId}:${subscriptionId}`, status);
      },
    };

    return { store, attempts };
  }

  const APNS: PushSubscriptionRecord = {
    id: 'sub-apns',
    user_id: 'user-1',
    channel: 'apns',
    device_token: 'A'.repeat(64),
    apns_environment: 'production',
  };
  const WEB: PushSubscriptionRecord = {
    id: 'sub-web',
    user_id: 'user-1',
    channel: 'web_push',
    endpoint: 'https://push.example.test/abc',
    p256dh: 'p'.repeat(87),
    auth_secret: 'a'.repeat(22),
  };

  it('retries only the subscription that failed, and never re-sends the one that succeeded', async () => {
    const { store, attempts } = statefulStore([APNS, WEB]);
    const targets: string[] = [];

    // APNs accepts; Web Push is rate limited. The classic partial fanout.
    const sender = {
      async send(target: { channel: string; subscriptionId: string }) {
        targets.push(`${target.channel}:${target.subscriptionId}`);
        return target.channel === 'apns'
          ? { ok: true as const, providerMessageId: 'APNS-ID-0001' }
          : { ok: false as const, statusCode: 503 };
      },
    } as unknown as PushSender;

    // ── Pass 1 ──
    const first = fakeQueue([[job(1)], []]);
    const one = await runNotificationDelivery({ deps: { queue: first.queue, store, sender } });

    expect(one.sent).toBe(1);
    expect(first.rescheduled).toHaveLength(1);
    expect(first.completed).toHaveLength(0);
    expect(targets).toEqual(['apns:sub-apns', 'web_push:sub-web']);
    expect(attempts.get(`${job(1).job_notification_id}:sub-apns`)).toBe('sent');
    expect(attempts.get(`${job(1).job_notification_id}:sub-web`)).toBe('temporary_failure');

    // ── Pass 2: the retry, same store, same notification ──
    targets.length = 0;
    const second = fakeQueue([[job(1)], []]);
    await runNotificationDelivery({ deps: { queue: second.queue, store, sender } });

    // THE ASSERTION THIS PHASE TURNS ON. The phone that already buzzed is not
    // asked again; only the endpoint that failed is retried.
    expect(targets).toEqual(['web_push:sub-web']);
    expect(targets).not.toContain('apns:sub-apns');
  });

  it('completes the job once the retried subscription finally succeeds', async () => {
    const { store } = statefulStore([APNS, WEB]);
    let webCalls = 0;

    const sender = {
      async send(target: { channel: string }) {
        if (target.channel === 'apns') {
          return { ok: true as const, providerMessageId: 'APNS-ID-0002' };
        }
        webCalls += 1;
        // Fails once, then succeeds — the ordinary transient case.
        return webCalls === 1
          ? { ok: false as const, statusCode: 503 }
          : { ok: true as const };
      },
    } as unknown as PushSender;

    const first = fakeQueue([[job(1)], []]);
    await runNotificationDelivery({ deps: { queue: first.queue, store, sender } });
    expect(first.rescheduled).toHaveLength(1);

    const second = fakeQueue([[job(1)], []]);
    const result = await runNotificationDelivery({
      deps: { queue: second.queue, store, sender },
    });

    expect(second.completed).toEqual([job(1).job_id]);
    expect(second.rescheduled).toHaveLength(0);
    expect(result.sent).toBe(1); // only the web push — APNs was skipped
  });

  it('does not retry a subscription that was permanently refused', async () => {
    const { store } = statefulStore([APNS, WEB]);
    const targets: string[] = [];

    const sender = {
      async send(target: { channel: string; subscriptionId: string }) {
        targets.push(target.subscriptionId);
        return target.channel === 'apns'
          ? { ok: false as const, statusCode: 410 } // gone → invalidated, terminal
          : { ok: false as const, statusCode: 503 }; // retryable
      },
    } as unknown as PushSender;

    const first = fakeQueue([[job(1)], []]);
    await runNotificationDelivery({ deps: { queue: first.queue, store, sender } });
    expect(first.rescheduled).toHaveLength(1);

    targets.length = 0;
    const second = fakeQueue([[job(1)], []]);
    await runNotificationDelivery({ deps: { queue: second.queue, store, sender } });

    expect(targets).toEqual(['sub-web']);
  });
});

describe('Phase 3C — a provider verdict reaches the right terminal decision', () => {
  /**
   * The seam between `classify.ts` and the retry policy.
   *
   * Both ends were already tested — the classifier knows `TooManyRequests` is
   * temporary, and the worker knows a retryable outcome means reschedule — but
   * nothing joined them. Reclassifying one reason, or changing which field the
   * worker reads, would have gone unnoticed by every existing test.
   *
   * These run the REAL dispatcher over a real subscription so the whole chain
   * is exercised: provider answer → classify → `retryable` → reschedule.
   */
  function apnsPair(reply: { status: number; reason: string | null }) {
    const store = statefulPair();
    const sender = {
      async send() {
        return reply.status === 200
          ? { ok: true as const }
          : {
              ok: false as const,
              apnsStatus: reply.status,
              apnsReason: reply.reason,
            };
      },
    } as unknown as PushSender;
    return { store, sender };
  }

  function webPair(reply: { statusCode?: number; error?: unknown }) {
    const store = statefulPair('web');
    const sender = {
      async send() {
        return reply.error !== undefined
          ? { ok: false as const, error: reply.error }
          : { ok: false as const, statusCode: reply.statusCode! };
      },
    } as unknown as PushSender;
    return { store, sender };
  }

  function statefulPair(kind: 'apns' | 'web' = 'apns'): PushDispatchStore {
    const subscription: PushSubscriptionRecord =
      kind === 'apns'
        ? {
            id: 'sub-1',
            user_id: 'user-1',
            channel: 'apns',
            device_token: 'A'.repeat(64),
            apns_environment: 'production',
          }
        : {
            id: 'sub-1',
            user_id: 'user-1',
            channel: 'web_push',
            endpoint: 'https://push.example.test/x',
            p256dh: 'p'.repeat(87),
            auth_secret: 'a'.repeat(22),
          };

    return {
      loadNotifications: async (ids) =>
        ids.map((id) => ({
          id,
          type: 'match_published' as const,
          title: 'T',
          body: 'B',
          deep_link: '/leagues/x/matches/y',
        })),
      loadRecipients: async (ids) => new Map(ids.map((id) => [id, 'user-1'])),
      loadEnabledSubscriptions: async () => [subscription],
      alreadyDelivered: async () => false,
      recordResult: async () => undefined,
    };
  }

  it.each([
    ['TooManyRequests', 429],
    ['IdleTimeout', 503],
    ['InternalServerError', 500],
    ['ServiceUnavailable', 503],
    ['Shutdown', 503],
  ])('APNs %s is retried, not abandoned', async (reason, status) => {
    const { store, sender } = apnsPair({ status, reason });
    const q = fakeQueue([[job(1)], []]);

    await runNotificationDelivery({ deps: { queue: q.queue, store, sender } });

    expect(q.rescheduled).toEqual([{ id: job(1).job_id, category: 'temporary_failure' }]);
    expect(q.completed).toHaveLength(0);
    expect(q.failed).toHaveLength(0);
  });

  it.each([
    ['ExpiredProviderToken', 403],
    ['InvalidProviderToken', 403],
    ['BadDeviceToken', 400],
    ['Unregistered', 410],
    ['PayloadTooLarge', 413],
  ])('APNs %s is terminal, never retried', async (reason, status) => {
    const { store, sender } = apnsPair({ status, reason });
    const q = fakeQueue([[job(1)], []]);

    await runNotificationDelivery({ deps: { queue: q.queue, store, sender } });

    expect(q.rescheduled).toHaveLength(0);
    expect(q.failed).toEqual([{ id: job(1).job_id, category: 'all_attempts_failed' }]);
  });

  it.each([[429], [500], [502], [503], [504]])(
    'Web Push %i is retried, not abandoned',
    async (statusCode) => {
      const { store, sender } = webPair({ statusCode });
      const q = fakeQueue([[job(1)], []]);

      await runNotificationDelivery({ deps: { queue: q.queue, store, sender } });

      expect(q.rescheduled).toHaveLength(1);
    },
  );

  it.each([
    ['TimeoutError', Object.assign(new Error('slow'), { name: 'TimeoutError' })],
    ['AbortError', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['a plain network fault', new Error('ECONNRESET')],
  ])('Web Push %s is retried, not abandoned', async (_label, error) => {
    const { store, sender } = webPair({ error });
    const q = fakeQueue([[job(1)], []]);

    await runNotificationDelivery({ deps: { queue: q.queue, store, sender } });

    expect(q.rescheduled).toHaveLength(1);
  });

  it.each([[404], [410], [400], [401], [403], [413]])(
    'Web Push %i is terminal, never retried',
    async (statusCode) => {
      const { store, sender } = webPair({ statusCode });
      const q = fakeQueue([[job(1)], []]);

      await runNotificationDelivery({ deps: { queue: q.queue, store, sender } });

      expect(q.rescheduled).toHaveLength(0);
      expect(q.failed).toHaveLength(1);
    },
  );
});

describe("Phase 3C does not disturb the APNs sender's own token refresh", () => {
  /**
   * `ExpiredProviderToken` is the one failure the sender fixes in place: it
   * drops the cached JWT, signs a new one and retries the HTTP request once,
   * immediately. That has existed since Build #2 and is a different mechanism
   * from Phase 3C's durable backoff — one lives below `send()`, the other above
   * it, and neither should be able to swallow the other.
   *
   * This runs the REAL `createApnsSender` over a scripted transport, through
   * the REAL dispatcher and worker, so the whole stack is exercised.
   */
  function apnsConfig(): ApnsConfiguration {
    const key = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;

    return {
      teamId: 'TEAMID1234',
      bundleId: 'com.example.test',
      keys: {
        development: { keyId: 'SANDBOX123', privateKey: key },
        production: { keyId: 'PRODUCTN456', privateKey: key },
      },
    };
  }

  function scriptedTransport(replies: Array<{ status: number; body: string }>) {
    const requests: unknown[] = [];
    return {
      requests,
      transport: {
        post: async (request: unknown) => {
          requests.push(request);
          const index = Math.min(requests.length - 1, replies.length - 1);
          return replies[index]!;
        },
      },
    };
  }

  const EXPIRED = { status: 403, body: '{"reason":"ExpiredProviderToken"}' };

  function storeFor(recorded: Array<{ subscriptionId: string; status: string }>) {
    const terminal = new Set<string>();
    const store: PushDispatchStore = {
      loadNotifications: async (ids) =>
        ids.map((id) => ({
          id,
          type: 'match_published' as const,
          title: 'T',
          body: 'B',
          deep_link: '/leagues/x/matches/y',
        })),
      loadRecipients: async (ids) => new Map(ids.map((id) => [id, 'user-1'])),
      loadEnabledSubscriptions: async () => [
        {
          id: 'sub-apns',
          user_id: 'user-1',
          channel: 'apns' as const,
          device_token: 'A'.repeat(64),
          apns_environment: 'production' as const,
        },
      ],
      alreadyDelivered: async (_n, subscriptionId) => terminal.has(subscriptionId),
      recordResult: async (_n, subscriptionId, status) => {
        recorded.push({ subscriptionId, status });
        if (status === 'sent' || status === 'permanent_failure' || status === 'invalidated') {
          terminal.add(subscriptionId);
        }
      },
    };
    return store;
  }

  beforeEach(() => {
    resetProviderTokenCache();
  });

  it('recovers in place: two HTTP requests, ONE recorded outcome, job completed', async () => {
    const recorded: Array<{ subscriptionId: string; status: string }> = [];
    const { transport, requests } = scriptedTransport([EXPIRED, { status: 200, body: '' }]);
    const sender = createApnsSender(apnsConfig(), transport);
    const q = fakeQueue([[job(1)], []]);

    const result = await runNotificationDelivery({
      deps: { queue: q.queue, store: storeFor(recorded), sender },
    });

    // The sender retried underneath us.
    expect(requests).toHaveLength(2);
    // …and the dispatcher above it saw a single send with a single outcome.
    expect(recorded).toEqual([{ subscriptionId: 'sub-apns', status: 'sent' }]);
    expect(result.sent).toBe(1);
    // Phase 3C did NOT schedule a durable retry for something already fixed.
    expect(q.rescheduled).toHaveLength(0);
    expect(q.completed).toEqual([job(1).job_id]);
  });

  it('does not re-send to that subscription on any later pass', async () => {
    // The recovered send is terminal like any other success, so even if the job
    // were claimed again the phone is not asked twice.
    const recorded: Array<{ subscriptionId: string; status: string }> = [];
    const store = storeFor(recorded);
    const { transport, requests } = scriptedTransport([EXPIRED, { status: 200, body: '' }]);
    const sender = createApnsSender(apnsConfig(), transport);

    await runNotificationDelivery({ deps: { queue: fakeQueue([[job(1)], []]).queue, store, sender } });
    expect(requests).toHaveLength(2);

    await runNotificationDelivery({ deps: { queue: fakeQueue([[job(1)], []]).queue, store, sender } });

    // No third request: `alreadyDelivered` skipped the pair.
    expect(requests).toHaveLength(2);
    expect(recorded).toHaveLength(1);
  });

  it('hands a still-expired token to 3C as a PERMANENT failure, not a retry', async () => {
    // The refresh did not help, so this is our own credential problem. Backing
    // off five times would not fix a key an operator has to rotate — and the
    // classifier has always called it permanent.
    const recorded: Array<{ subscriptionId: string; status: string }> = [];
    const { transport, requests } = scriptedTransport([EXPIRED]);
    const sender = createApnsSender(apnsConfig(), transport);
    const q = fakeQueue([[job(1)], []]);

    await runNotificationDelivery({
      deps: { queue: q.queue, store: storeFor(recorded), sender },
    });

    expect(requests).toHaveLength(2); // tried once more, then gave up
    expect(recorded).toEqual([{ subscriptionId: 'sub-apns', status: 'permanent_failure' }]);
    expect(q.rescheduled).toHaveLength(0);
    expect(q.failed).toEqual([{ id: job(1).job_id, category: 'all_attempts_failed' }]);
  });

  it('still applies 3C backoff when the retry hits a genuinely transient answer', async () => {
    // Refresh succeeded in signing, but Apple was busy. That IS retryable, and
    // the durable schedule must pick it up.
    const recorded: Array<{ subscriptionId: string; status: string }> = [];
    const { transport, requests } = scriptedTransport([
      EXPIRED,
      { status: 503, body: '{"reason":"ServiceUnavailable"}' },
    ]);
    const sender = createApnsSender(apnsConfig(), transport);
    const q = fakeQueue([[job(1)], []]);

    await runNotificationDelivery({
      deps: { queue: q.queue, store: storeFor(recorded), sender },
    });

    expect(requests).toHaveLength(2);
    expect(recorded).toEqual([{ subscriptionId: 'sub-apns', status: 'temporary_failure' }]);
    expect(q.rescheduled).toEqual([{ id: job(1).job_id, category: 'temporary_failure' }]);
  });
});

describe('Phase 3D — two channels on one job', () => {
  /**
   * THE ARCHITECTURE TEST FOR THIS PHASE.
   *
   * A job now owes work to push AND email. It is finished only when every
   * applicable channel has reached a terminal outcome, and a retry must resend
   * to nobody who already received it — across channels, not just within one.
   *
   * Both stores keep state between passes and apply the same terminal rule
   * their real counterparts do, so a second worker pass sees exactly what
   * production would see.
   */
  const FROM = 'MatchDay <notifications@example.test>';
  const APNS: PushSubscriptionRecord = {
    id: 'sub-apns',
    user_id: 'user-1',
    channel: 'apns',
    device_token: 'A'.repeat(64),
    apns_environment: 'production',
  };
  const WEB: PushSubscriptionRecord = {
    id: 'sub-web',
    user_id: 'user-1',
    channel: 'web_push',
    endpoint: 'https://push.example.test/abc',
    p256dh: 'p'.repeat(87),
    auth_secret: 'a'.repeat(22),
  };

  function pushSide(subscriptions: PushSubscriptionRecord[]) {
    const terminal = new Set<string>();
    const store: PushDispatchStore = {
      loadNotifications: async (ids) =>
        ids.map((id) => ({
          id,
          type: 'match_published' as const,
          title: 'T',
          body: 'B',
          deep_link: '/leagues/x/matches/y',
        })),
      loadRecipients: async (ids) => new Map(ids.map((id) => [id, 'user-1'])),
      loadEnabledSubscriptions: async () => subscriptions,
      alreadyDelivered: async (_n, subscriptionId) => terminal.has(subscriptionId),
      recordResult: async (_n, subscriptionId, status) => {
        if (status === 'sent' || status === 'permanent_failure' || status === 'invalidated') {
          terminal.add(subscriptionId);
        }
      },
    };
    return store;
  }

  function emailSide(recipient: string | null = 'player@example.test') {
    let settled = false;
    let fingerprint: string | null = null;
    const store: EmailDispatchStore = {
      loadNotifications: async (ids) =>
        ids.map((id) => ({
          id,
          type: 'match_published' as const,
          title: 'T',
          body: 'B',
          deep_link: '/leagues/x/matches/y',
        })),
      resolveRecipient: async () => recipient,
      loadAttempt: async () => ({ settled, payloadFingerprint: fingerprint }),
      recordResult: async (_n, status, _c, _p, printed) => {
        if (printed != null) {
          fingerprint ??= printed;
        }
        if (status === 'sent' || status === 'permanent_failure') {
          settled = true;
        }
      },
    };
    return store;
  }

  it('APNs sent + Web Push sent + email rate limited → retry sends EMAIL ONLY', async () => {
    const store = pushSide([APNS, WEB]);
    const emailStore = emailSide();
    const pushTargets: string[] = [];
    const emailSends: string[] = [];

    const sender = {
      async send(target: { channel: string; subscriptionId: string }) {
        pushTargets.push(target.subscriptionId);
        return { ok: true as const, providerMessageId: 'p' };
      },
    } as unknown as PushSender;

    let emailCalls = 0;
    const emailSender: EmailSender = {
      async send(message) {
        emailCalls += 1;
        emailSends.push(message.to);
        return emailCalls === 1
          ? { ok: false as const, statusCode: 429 }
          : { ok: true as const, providerMessageId: 'r' };
      },
    };

    const deps = { store, sender, emailStore, emailSender, baseUrl: 'https://app.matchdayapps.com', emailFrom: FROM };

    // ── Pass 1 ──
    const first = fakeQueue([[job(1)], []]);
    const one = await runNotificationDelivery({ deps: { queue: first.queue, ...deps } });

    expect(pushTargets).toEqual(['sub-apns', 'sub-web']);
    expect(emailSends).toHaveLength(1);
    expect(one.sent).toBe(2); // both pushes; the email failed
    expect(one.mailSent).toBe(0);
    // NOT completed — email still owes work.
    expect(first.rescheduled).toHaveLength(1);
    expect(first.completed).toHaveLength(0);

    // ── Pass 2: the retry ──
    pushTargets.length = 0;
    emailSends.length = 0;
    const second = fakeQueue([[job(1)], []]);
    const two = await runNotificationDelivery({ deps: { queue: second.queue, ...deps } });

    // THE ASSERTION THIS PHASE TURNS ON.
    expect(pushTargets).toEqual([]); // neither phone asked again
    expect(emailSends).toHaveLength(1); // only the email retried
    expect(two.mailSent).toBe(1);
    expect(second.completed).toEqual([job(1).job_id]);
  });

  it('email sent + push rate limited → retry sends PUSH ONLY', async () => {
    const store = pushSide([APNS]);
    const emailStore = emailSide();
    const pushTargets: string[] = [];
    const emailSends: string[] = [];

    let pushCalls = 0;
    const sender = {
      async send(target: { subscriptionId: string }) {
        pushCalls += 1;
        pushTargets.push(target.subscriptionId);
        return pushCalls === 1
          ? { ok: false as const, statusCode: 503 }
          : { ok: true as const, providerMessageId: 'p' };
      },
    } as unknown as PushSender;

    const emailSender: EmailSender = {
      async send(message) {
        emailSends.push(message.to);
        return { ok: true as const, providerMessageId: 'r' };
      },
    };

    const deps = { store, sender, emailStore, emailSender, baseUrl: 'https://app.matchdayapps.com', emailFrom: FROM };

    const first = fakeQueue([[job(1)], []]);
    const one = await runNotificationDelivery({ deps: { queue: first.queue, ...deps } });

    expect(emailSends).toHaveLength(1);
    expect(one.mailSent).toBe(1);
    expect(first.rescheduled).toHaveLength(1);

    pushTargets.length = 0;
    emailSends.length = 0;
    const second = fakeQueue([[job(1)], []]);
    await runNotificationDelivery({ deps: { queue: second.queue, ...deps } });

    expect(pushTargets).toEqual(['sub-apns']); // push retried
    expect(emailSends).toEqual([]); // the email is NOT sent twice
    expect(second.completed).toEqual([job(1).job_id]);
  });

  it('email sent + push permanently refused → completed, not retried', async () => {
    const store = pushSide([APNS]);
    const emailStore = emailSide();

    const sender = {
      async send() {
        return { ok: false as const, statusCode: 400 }; // permanent
      },
    } as unknown as PushSender;
    const emailSender: EmailSender = { async send() { return { ok: true as const }; } };

    const q = fakeQueue([[job(1)], []]);
    const result = await runNotificationDelivery({
      deps: {
        queue: q.queue,
        store,
        sender,
        emailStore,
        emailSender,
        baseUrl: 'https://app.matchdayapps.com',
        emailFrom: FROM,
      },
    });

    // Something was delivered and nothing retryable remains.
    expect(q.rescheduled).toHaveLength(0);
    expect(q.completed).toEqual([job(1).job_id]);
    expect(result.mailSent).toBe(1);
  });

  it('no push subscriptions at all + a successful email still completes', async () => {
    const store = pushSide([]);
    const emailStore = emailSide();
    const emailSender: EmailSender = { async send() { return { ok: true as const }; } };

    const q = fakeQueue([[job(1)], []]);
    const result = await runNotificationDelivery({
      deps: {
        queue: q.queue,
        store,
        sender: { send: vi.fn() } as unknown as PushSender,
        emailStore,
        emailSender,
        baseUrl: 'https://app.matchdayapps.com',
        emailFrom: FROM,
      },
    });

    expect(q.completed).toEqual([job(1).job_id]);
    expect(result.mailSent).toBe(1);
    expect(result.sent).toBe(1);
  });

  it('no enabled channel at all remains a completed no-op', async () => {
    // No devices, and email switched off. Nothing is owed and nothing waits.
    const store = pushSide([]);
    const emailStore = emailSide(null);
    const emailSender: EmailSender = { async send() { throw new Error('must not be called'); } };

    const q = fakeQueue([[job(1)], []]);
    const result = await runNotificationDelivery({
      deps: {
        queue: q.queue,
        store,
        sender: { send: vi.fn() } as unknown as PushSender,
        emailStore,
        emailSender,
        baseUrl: 'https://app.matchdayapps.com',
        emailFrom: FROM,
      },
    });

    expect(q.completed).toEqual([job(1).job_id]);
    expect(q.rescheduled).toHaveLength(0);
    expect(result.sent).toBe(0);
    expect(result.mailSent).toBe(0);
  });

  it('a deployment with no email configured behaves exactly as Phase 3C did', async () => {
    const store = pushSide([APNS]);
    const sender = {
      async send() {
        return { ok: true as const, providerMessageId: 'p' };
      },
    } as unknown as PushSender;

    const q = fakeQueue([[job(1)], []]);
    const result = await runNotificationDelivery({
      deps: { queue: q.queue, store, sender, emailStore: null, emailSender: null },
    });

    expect(q.completed).toEqual([job(1).job_id]);
    expect(result.sent).toBe(1);
    expect(result.mailSent).toBe(0);
  });

  it('an email switched off does not stop push, and calls no provider', async () => {
    const store = pushSide([APNS]);
    const emailStore = emailSide(null);
    const emailSender: EmailSender = {
      async send() {
        throw new Error('the provider must not be called when email is off');
      },
    };
    const sender = {
      async send() {
        return { ok: true as const, providerMessageId: 'p' };
      },
    } as unknown as PushSender;

    const q = fakeQueue([[job(1)], []]);
    const result = await runNotificationDelivery({
      deps: {
        queue: q.queue,
        store,
        sender,
        emailStore,
        emailSender,
        baseUrl: 'https://app.matchdayapps.com',
        emailFrom: FROM,
      },
    });

    expect(result.sent).toBe(1);
    expect(result.mailSent).toBe(0);
    expect(q.completed).toEqual([job(1).job_id]);
  });
});

describe('when the queue itself is unreachable', () => {
  it('reports failure rather than an empty run', async () => {
    const { queue } = fakeQueue([]);
    queue.claim = async () => {
      throw Object.assign(new Error('nope'), { code: '42501' });
    };

    const result = await runNotificationDelivery({ deps: deps(queue) });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('42501');
    expect(deliveryRunFailed(result)).toBe(true);
    expect(mocks.logError).toHaveBeenCalledWith(
      'notification_delivery.failed',
      expect.objectContaining({ error_code: '42501' }),
    );
  });

  it('keeps the counts it had already earned', async () => {
    // The first batch was genuinely delivered. A later claim failing must not
    // erase that from the operator's view.
    let call = 0;
    const { queue, completed } = fakeQueue([[job(1)]]);
    const inner = queue.claim.bind(queue);
    queue.claim = async (w, l, s) => {
      if (call++ === 1) {
        throw new Error('gone');
      }
      return inner(w, l, s);
    };

    const result = await runNotificationDelivery({
      deps: deps(queue, scenario({ attempted: 1, sent: 1 })),
      batchSize: 1,
    });

    expect(result.status).toBe('failed');
    expect(result.claimed).toBe(1);
    expect(completed).toHaveLength(1);
  });
});

describe('logs', () => {
  it('emits only loggable keys, and nothing identifying', async () => {
    const { assertLoggable } = await import('@/lib/observability/log');
    const { queue } = fakeQueue([[job(1)], []]);

    await runNotificationDelivery({
      deps: deps(queue, scenario({ attempted: 1, sent: 0 })),
    });
    await runNotificationDelivery({ deps: deps(queue, { sender: null }) });

    const everyCall = [
      ...mocks.logInfo.mock.calls,
      ...mocks.logWarn.mock.calls,
      ...mocks.logError.mock.calls,
    ];
    expect(everyCall.length).toBeGreaterThan(0);
    for (const [event, fields] of everyCall) {
      expect(assertLoggable(fields as ObservabilityLog.LogFields), `${String(event)}`).toBe(true);
    }
  });

  it('never logs a device token or an endpoint', async () => {
    const { store, sender } = scenario({ attempted: 1, sent: 0 });
    const { queue } = fakeQueue([[job(1)], []]);

    await runNotificationDelivery({ deps: deps(queue, { store, sender }) });

    const logged = JSON.stringify([
      ...mocks.logInfo.mock.calls,
      ...mocks.logWarn.mock.calls,
      ...mocks.logError.mock.calls,
    ]);
    for (const secret of ['TOKEN', 'https://', 'endpoint', 'device_token', 'p256dh']) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('the worker holds no transaction across the network', () => {
  it('claims, then dispatches, then records — never inside one call', async () => {
    // Stated structurally, because it is not observable from the outside: the
    // claim is its own RPC, the provider call happens after it returns, and the
    // completion is a third RPC. A single SQL function that claimed and
    // dispatched would hold a row lock for as long as Apple felt like taking.
    const source = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '../../src/server/notification-delivery.ts'),
      'utf8',
    );

    expect(source).toContain('await queue.claim(');
    expect(source).toContain('await dispatchPushNotifications(');
    expect(source).toMatch(/await queue\.(complete|fail)\(/);
    // No transaction control anywhere in the worker.
    for (const forbidden of ['begin', 'commit', 'rollback']) {
      expect(source.toLowerCase()).not.toContain(`'${forbidden}'`);
    }
  });
});

/**
 * A dispatch pair that will attempt `attempted` sends, of which `sent` succeed.
 *
 * Built as a pair because the two halves have to agree: the store decides how
 * many devices exist, the sender decides how many of them answer. Splitting
 * them was the first version of this file and produced tests that passed while
 * dispatching nothing at all.
 */
function scenario({
  attempted,
  sent,
  failWith = 'temporary',
}: {
  attempted: number;
  sent: number;
  /**
   * Which kind of refusal the failing sends get.
   *
   * 503 classifies `temporary_failure` and 400 `permanent_failure`. Since Phase
   * 3C those lead to opposite outcomes — reschedule versus terminal — so a test
   * that does not say which it means is not testing anything.
   */
  failWith?: 'temporary' | 'permanent';
}): {
  store: PushDispatchStore;
  sender: PushSender;
} {
  const subscriptions = Array.from({ length: attempted }, (_, index) => ({
    id: `sub-${index}`,
    user_id: 'user-1',
    channel: 'apns' as const,
    device_token: 'TOKEN',
    apns_environment: 'production' as const,
  }));

  const store: PushDispatchStore = {
    loadNotifications: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        type: 'match_published' as const,
        title: 'T',
        body: 'B',
        deep_link: '/leagues/x/matches/y',
      })),
    ),
    loadRecipients: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, 'user-1']))),
    loadEnabledSubscriptions: vi.fn(async () => subscriptions),
    alreadyDelivered: vi.fn(async () => false),
    recordResult: vi.fn(async () => undefined),
  };

  let calls = 0;
  const sender = {
    async send() {
      calls += 1;
      return calls <= sent
        ? { ok: true as const, providerMessageId: 'id' }
        : { ok: false as const, statusCode: failWith === 'temporary' ? 503 : 400 };
    },
  } as unknown as PushSender;

  return { store, sender };
}

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ObservabilityLog from '@/lib/observability/log';
import type { DeliveryQueueStore } from '@/lib/notifications/delivery-queue';
import type { PushDispatchStore } from '@/lib/push/dispatch';
import type { PushSender } from '@/lib/push/sender';
import type { ClaimedDeliveryJob } from '@/types/database';

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
  let call = 0;

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
  };

  return { queue, claims, completed, failed };
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
      sent: 0,
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

  it('completes a job that reached some devices but not others', async () => {
    // One member with a dead endpoint is an ordinary, successful fanout. The
    // per-device outcome is already on `push_delivery_attempts`; the job is
    // not the place to re-litigate it.
    const { queue, completed, failed } = fakeQueue([[job(1)], []]);
    const { store, sender } = scenario({ attempted: 3, sent: 1 });

    await runNotificationDelivery({ deps: deps(queue, { store, sender }) });

    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(0);
  });

  it('fails a job when every attempt it made was rejected', async () => {
    const { queue, completed, failed } = fakeQueue([[job(1)], []]);
    const { store, sender } = scenario({ attempted: 2, sent: 0 });

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
function scenario({ attempted, sent }: { attempted: number; sent: number }): {
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
        : { ok: false as const, statusCode: 503 };
    },
  } as unknown as PushSender;

  return { store, sender };
}

import type { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asServiceRole,
  asServiceRoleCommitting,
  asUser,
  connectAsWorker,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_LEAGUES,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

/**
 * Phase 3C's retry schedule, against real PostgreSQL.
 *
 * Time eligibility is the whole point of this phase, and it is exactly the kind
 * of thing that passes under a mock and fails in production. Everything below
 * asks the real database whether a job is claimable *now*, rather than asserting
 * on a number a fake returned.
 *
 * The one thing deliberately NOT tested here is the worker's decision logic —
 * that lives in `tests/unit/notification-delivery-run.test.ts`, because it is a
 * pure function of a dispatch result and needs no database to be honest.
 */

interface JobRow {
  id: string;
  status: string;
  attempts: number;
  provider_attempts: number;
  next_attempt_at: string;
  lease_expires_at: string | null;
  completed_at: string | null;
  last_error_category: string | null;
  claimed_by: string | null;
}

describe('notification delivery retries', () => {
  let db: TestDatabase;
  let clients: Client[] = [];

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
    clients = [];
  });

  afterEach(async () => {
    await Promise.all(clients.map((c) => c.end()));
    await db.drop();
  });

  /** One push-eligible notification, committed, returning its job id. */
  async function queueOne(key = `retry-${Math.random()}`): Promise<string> {
    return asServiceRoleCommitting(db, async (client) => {
      // Two statements, deliberately. An AFTER INSERT trigger's row is not
      // visible to the same statement that fired it — a data-modifying CTE
      // reads the snapshot taken before the trigger ran, so joining to the
      // queue inside one statement returns nothing.
      const inserted = await client.query<{ id: string }>(
        `insert into public.notifications
           (recipient_user_id, league_id, type, title, body, deep_link,
            idempotency_key, delivery_metadata)
         values ($1, $2, 'match_published', 'T', 'B', '/leagues/x/matches/y', $3,
                 jsonb_build_object('push_eligible', true))
         returning id`,
        [SEED_USERS.rmvfcPlayer.id, SEED_LEAGUES.rmvfc, key],
      );

      const { rows } = await client.query<{ id: string }>(
        'select id from public.notification_delivery_jobs where notification_id = $1',
        [inserted.rows[0]!.id],
      );
      return rows[0]!.id;
    });
  }

  async function job(id: string): Promise<JobRow> {
    return asServiceRole(db, async (client) => {
      const { rows } = await client.query<JobRow>(
        `select id, status::text as status, attempts, provider_attempts,
                next_attempt_at, lease_expires_at, completed_at,
                last_error_category, claimed_by
           from public.notification_delivery_jobs where id = $1`,
        [id],
      );
      return rows[0]!;
    });
  }

  async function claim(worker = 'w-test', limit = 10): Promise<number> {
    return asServiceRoleCommitting(db, async (client) => {
      const { rows } = await client.query(
        'select * from public.claim_notification_delivery_jobs($1, $2, 120)',
        [worker, limit],
      );
      return rows.length;
    });
  }

  async function reschedule(
    jobId: string,
    category: string | null = 'temporary_failure',
  ): Promise<{ outcome: string; retry_number: number | null; delay_seconds: number | null }> {
    return asServiceRoleCommitting(db, async (client) => {
      const { rows } = await client.query<{
        outcome: string;
        retry_number: number | null;
        delay_seconds: string | null;
      }>(
        `select outcome, retry_number,
                round(extract(epoch from (scheduled_for - now())))::text as delay_seconds
           from public.reschedule_notification_delivery_job($1, $2)`,
        [jobId, category],
      );
      const r = rows[0]!;
      return {
        outcome: r.outcome,
        retry_number: r.retry_number,
        delay_seconds: r.delay_seconds === null ? null : Number(r.delay_seconds),
      };
    });
  }

  /** Makes a scheduled job due, without touching any other column. */
  async function makeDue(jobId: string): Promise<void> {
    await asServiceRoleCommitting(db, (client) =>
      client.query(
        `update public.notification_delivery_jobs
            set next_attempt_at = now() - interval '1 second' where id = $1`,
        [jobId],
      ),
    );
  }

  // ── The schedule ─────────────────────────────────────────────────────────

  describe('the backoff schedule', () => {
    it('is 1, 2, 5 and 15 minutes, then terminal on the fifth', async () => {
      const id = await queueOne('retry-schedule-0001');
      const seen: Array<{ n: number | null; delay: number | null; outcome: string }> = [];

      for (let round = 1; round <= 5; round += 1) {
        await claim();
        const r = await reschedule(id);
        seen.push({ n: r.retry_number, delay: r.delay_seconds, outcome: r.outcome });
        if (r.outcome === 'scheduled') {
          await makeDue(id);
        }
      }

      expect(seen).toEqual([
        { n: 1, delay: 60, outcome: 'scheduled' },
        { n: 2, delay: 120, outcome: 'scheduled' },
        { n: 3, delay: 300, outcome: 'scheduled' },
        { n: 4, delay: 900, outcome: 'scheduled' },
        { n: 5, delay: null, outcome: 'exhausted' },
      ]);
    });

    it.each([
      [1, 60],
      [2, 120],
      [3, 300],
      [4, 900],
    ])('temporary failure #%i schedules +%i seconds', async (round, expected) => {
      const id = await queueOne(`retry-single-${round}`);
      await asServiceRoleCommitting(db, (client) =>
        client.query(
          'update public.notification_delivery_jobs set provider_attempts = $2 where id = $1',
          [id, round - 1],
        ),
      );
      await claim();

      const r = await reschedule(id);

      expect(r.retry_number).toBe(round);
      expect(r.delay_seconds).toBe(expected);
    });

    it('leaves the job terminally failed with a distinguishable category', async () => {
      const id = await queueOne('retry-exhaust-0001');
      await asServiceRoleCommitting(db, (client) =>
        client.query(
          'update public.notification_delivery_jobs set provider_attempts = 4 where id = $1',
          [id],
        ),
      );
      await claim();

      const r = await reschedule(id);
      const after = await job(id);

      expect(r.outcome).toBe('exhausted');
      expect(after).toMatchObject({
        status: 'failed',
        provider_attempts: 5,
        // NOT `all_attempts_failed` (permanent refusal) and NOT
        // `dispatch_error` (internal fault). An operator can tell them apart.
        last_error_category: 'retries_exhausted',
      });
      expect(after.completed_at).not.toBeNull();
      expect(after.lease_expires_at).toBeNull();
    });
  });

  // ── Time eligibility ─────────────────────────────────────────────────────

  describe('a rescheduled job is not claimable until it is due', () => {
    it('is skipped before next_attempt_at and taken after', async () => {
      const id = await queueOne('retry-eligibility-01');
      await claim();
      await reschedule(id);

      expect(await claim('w-early')).toBe(0);

      await makeDue(id);
      expect(await claim('w-late')).toBe(1);
      expect((await job(id)).claimed_by).toBe('w-late');
    });

    it('returns to pending with the lease released', async () => {
      const id = await queueOne('retry-eligibility-02');
      await claim();
      await reschedule(id);

      const after = await job(id);
      expect(after.status).toBe('pending');
      expect(after.lease_expires_at).toBeNull();
      expect(after.completed_at).toBeNull();
      expect(new Date(after.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('does not starve fresh work behind a long backoff', async () => {
      // Claim order is `next_attempt_at`, so a job backed off fifteen minutes
      // does not sit at the head of the queue holding up a match published
      // thirty seconds ago.
      const backedOff = await queueOne('retry-order-old');
      await claim();
      await asServiceRoleCommitting(db, (client) =>
        client.query(
          'update public.notification_delivery_jobs set provider_attempts = 3 where id = $1',
          [backedOff],
        ),
      );
      await reschedule(backedOff);

      const fresh = await queueOne('retry-order-new');

      const claimedIds = await asServiceRoleCommitting(db, async (client) => {
        const { rows } = await client.query<{ job_id: string }>(
          `select job_id from public.claim_notification_delivery_jobs('w-order', 10, 120)`,
        );
        return rows.map((r) => r.job_id);
      });

      expect(claimedIds).toEqual([fresh]);
    });
  });

  // ── Lease recovery is a different thing ──────────────────────────────────

  describe('crash recovery and provider retry are separate', () => {
    it('a lease reclaim does not spend provider retry budget', async () => {
      // THE DEFECT THIS PREVENTS: a bad deploy restarts the worker three times,
      // three jobs get reclaimed three times, and every notification in flight
      // quietly exhausts its retries without a provider ever having refused
      // anything.
      const id = await queueOne('retry-lease-01');
      await claim('w-doomed');

      for (let i = 0; i < 3; i += 1) {
        await asServiceRoleCommitting(db, (client) =>
          client.query(
            `update public.notification_delivery_jobs
                set lease_expires_at = now() - interval '1 second' where id = $1`,
            [id],
          ),
        );
        expect(await claim(`w-reclaim-${i}`)).toBe(1);
      }

      const after = await job(id);
      expect(after.attempts).toBe(4); // one original claim + three reclaims
      expect(after.provider_attempts).toBe(0); // untouched — no provider refused anything
    });

    it('reclaims an expired lease even when next_attempt_at is far in the future', async () => {
      // A crashed worker is not waiting on a backoff. Gating the reclaim on
      // `next_attempt_at` would strand the job for as long as the backoff.
      const id = await queueOne('retry-lease-02');
      await claim('w-doomed');
      await asServiceRoleCommitting(db, (client) =>
        client.query(
          `update public.notification_delivery_jobs
              set lease_expires_at = now() - interval '1 second',
                  next_attempt_at  = now() + interval '1 hour'
            where id = $1`,
          [id],
        ),
      );

      expect(await claim('w-rescuer')).toBe(1);
    });

    it('still refuses to claim a terminal job', async () => {
      const id = await queueOne('retry-lease-03');
      await claim();
      await asServiceRoleCommitting(db, (client) =>
        client.query(
          `select public.complete_notification_delivery_job($1, 'completed', null)`,
          [id],
        ),
      );

      expect(await claim('w-after')).toBe(0);
    });
  });

  // ── Concurrency ──────────────────────────────────────────────────────────

  describe('two workers and one due retry', () => {
    it('never hands the same retry job to both', async () => {
      const id = await queueOne('retry-race-0001');
      await claim();
      await reschedule(id);
      await makeDue(id);

      const [a, b] = await Promise.all([connectAsWorker(db), connectAsWorker(db)]);
      clients.push(a!, b!);
      await Promise.all([a!.query('begin'), b!.query('begin')]);

      const [first, second] = await Promise.all([
        a!.query(`select * from public.claim_notification_delivery_jobs('w-a', 10, 120)`),
        b!.query(`select * from public.claim_notification_delivery_jobs('w-b', 10, 120)`),
      ]);

      await Promise.all([a!.query('commit'), b!.query('commit')]);

      expect([first.rows.length, second.rows.length].sort()).toEqual([0, 1]);
      expect((await job(id)).provider_attempts).toBe(1);
    });

    it('refuses to reschedule a job this worker no longer holds', async () => {
      const id = await queueOne('retry-race-0002');
      await claim();
      await reschedule(id); // now `pending`, not `processing`

      const second = await reschedule(id);

      expect(second.outcome).toBe('not_claimed');
      // The budget was not spent twice for one round.
      expect((await job(id)).provider_attempts).toBe(1);
    });
  });

  // ── Provider bookkeeping across a retry ──────────────────────────────────

  describe('push_delivery_attempts across retries', () => {
    async function subscription(channel: 'apns' | 'web_push', label: string): Promise<string> {
      return asServiceRoleCommitting(db, async (client) => {
        const { rows } =
          channel === 'apns'
            ? await client.query<{ id: string }>(
                `insert into public.push_subscriptions
                   (user_id, channel, device_token, apns_environment, installation_id, enabled)
                 values ($1, 'apns', $2, 'production', $3, true) returning id`,
                [SEED_USERS.rmvfcPlayer.id, 'A'.repeat(64), `1111aaaa-1111-4111-8111-${label}`],
              )
            : await client.query<{ id: string }>(
                `insert into public.push_subscriptions
                   (user_id, channel, endpoint, p256dh, auth_secret, enabled)
                 values ($1, 'web_push', $2, $3, $4, true) returning id`,
                [
                  SEED_USERS.rmvfcPlayer.id,
                  `https://push.example.test/${label}`,
                  'p'.repeat(87),
                  'a'.repeat(22),
                ],
              );
        return rows[0]!.id;
      });
    }

    async function notificationFor(jobId: string): Promise<string> {
      return asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ notification_id: string }>(
          'select notification_id from public.notification_delivery_jobs where id = $1',
          [jobId],
        );
        return rows[0]!.notification_id;
      });
    }

    async function record(
      notificationId: string,
      subscriptionId: string,
      status: string,
      category: string | null,
      providerMessageId: string | null,
    ): Promise<void> {
      await asServiceRoleCommitting(db, (client) =>
        client.query('select public.record_push_delivery_result($1, $2, $3, $4, $5)', [
          notificationId,
          subscriptionId,
          status,
          category,
          providerMessageId,
        ]),
      );
    }

    async function attempt(notificationId: string, subscriptionId: string) {
      return asServiceRole(db, async (client) => {
        const { rows } = await client.query(
          `select status::text as status, attempt_count, last_error_category,
                  provider_message_id, delivered_at
             from public.push_delivery_attempts
            where notification_id = $1 and subscription_id = $2`,
          [notificationId, subscriptionId],
        );
        return rows[0];
      });
    }

    it('increments attempt_count and can move temporary_failure to sent', async () => {
      const jobId = await queueOne('retry-attempts-01');
      const n = await notificationFor(jobId);
      const sub = await subscription('web_push', 'aaaaaaaaaaaa');

      await record(n, sub, 'temporary_failure', 'server_error', null);
      expect(await attempt(n, sub)).toMatchObject({
        status: 'temporary_failure',
        attempt_count: 1,
        last_error_category: 'server_error',
      });

      await record(n, sub, 'sent', null, null);
      const after = await attempt(n, sub);
      expect(after).toMatchObject({ status: 'sent', attempt_count: 2 });
      expect(after.delivered_at).not.toBeNull();
    });

    it('keeps one row per (notification, subscription) however many retries', async () => {
      const jobId = await queueOne('retry-attempts-02');
      const n = await notificationFor(jobId);
      const sub = await subscription('web_push', 'bbbbbbbbbbbb');

      for (let i = 0; i < 4; i += 1) {
        await record(n, sub, 'temporary_failure', 'rate_limited', null);
      }

      const rows = await asServiceRole(db, async (client) => {
        const { rows } = await client.query(
          'select count(*)::int as c from public.push_delivery_attempts where notification_id = $1',
          [n],
        );
        return rows[0]!.c;
      });

      expect(rows).toBe(1);
      expect((await attempt(n, sub)).attempt_count).toBe(4);
    });

    it('does not erase a provider_message_id a retry did not supply', async () => {
      const jobId = await queueOne('retry-attempts-03');
      const n = await notificationFor(jobId);
      const sub = await subscription('apns', 'cccccccccccc');

      await record(n, sub, 'temporary_failure', 'server_error', 'APNS-ID-0001');
      await record(n, sub, 'temporary_failure', 'timeout', null);

      expect((await attempt(n, sub)).provider_message_id).toBe('APNS-ID-0001');
    });

    it('PARTIAL FANOUT: a sent pair stays terminal while a failed pair does not', async () => {
      // The database half of the partial-fanout guarantee. `push-store.ts`
      // treats sent / permanent_failure / invalidated as terminal and skips
      // them; a `temporary_failure` pair is the only one it will try again.
      //
      // The dispatcher half — that a retry pass therefore calls the provider
      // only for the still-failing subscription — is proved with the real
      // dispatcher in `tests/unit/notification-delivery-run.test.ts`.
      const jobId = await queueOne('retry-partial-0001');
      const n = await notificationFor(jobId);
      const apns = await subscription('apns', 'dddddddddddd');
      const web = await subscription('web_push', 'eeeeeeeeeeee');

      await record(n, apns, 'sent', null, 'APNS-ID-0002');
      await record(n, web, 'temporary_failure', 'server_error', null);

      const terminal = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ subscription_id: string; is_terminal: boolean }>(
          `select subscription_id,
                  status in ('sent','permanent_failure','invalidated') as is_terminal
             from public.push_delivery_attempts where notification_id = $1`,
          [n],
        );
        return new Map(rows.map((r) => [r.subscription_id, r.is_terminal]));
      });

      expect(terminal.get(apns)).toBe(true); // never sent again
      expect(terminal.get(web)).toBe(false); // the only one retried
    });
  });

  // ── Access ───────────────────────────────────────────────────────────────

  describe('the retry RPC is worker-only', () => {
    it('refuses an ordinary member', async () => {
      const id = await queueOne('retry-rls-0001');

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('select * from public.reschedule_notification_delivery_job($1, null)', [id]),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('still hides the new columns from an ordinary member', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(
            'select next_attempt_at, provider_attempts from public.notification_delivery_jobs',
          ),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });
});

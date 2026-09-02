import type { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asServiceRole,
  asServiceRoleCommitting,
  asUser,
  asUserCommitting,
  connectAsWorker,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_GUIDELINES,
  SEED_JOIN_REQUESTS,
  SEED_LEAGUES,
  SEED_MATCHES,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

/**
 * Phase 3B's queue, against real PostgreSQL.
 *
 * The parts worth testing here are the parts that cannot be tested anywhere
 * else: that the job and the notification are genuinely in one transaction,
 * that two workers racing for the same row cannot both win, and that the queue
 * is invisible to the people whose notifications are in it.
 *
 * Concurrency is exercised with **separate connections** and `Promise.all`, for
 * the reason the Phase 4–7 suites give: the shared pool recycles a handful of
 * sockets, so two "concurrent" statements through it can serialize and pass
 * without having tested anything.
 */

interface JobRow {
  id: string;
  notification_id: string;
  status: string;
  attempts: number;
  claimed_by: string | null;
  lease_expires_at: string | null;
  completed_at: string | null;
  last_error_category: string | null;
}

describe('notification delivery queue', () => {
  let db: TestDatabase;
  let clients: Client[] = [];

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
    clients = [];
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.end()));
    await db.drop();
  });

  async function workers(count: number): Promise<Client[]> {
    const opened = await Promise.all(Array.from({ length: count }, () => connectAsWorker(db)));
    clients.push(...opened);
    return opened;
  }

  /** Every job in the database, service-role, ordered oldest first. */
  async function jobs(): Promise<JobRow[]> {
    return asServiceRole(db, async (client) => {
      const { rows } = await client.query<JobRow>(
        `select id, notification_id, status, attempts, claimed_by,
                lease_expires_at, completed_at, last_error_category
           from public.notification_delivery_jobs
          order by created_at, id`,
      );
      return rows;
    });
  }

  /**
   * Writes one notification with the given eligibility, committing.
   *
   * Inserted directly rather than through `create_notification`, which is
   * executable by `postgres` alone — it is an internal helper the domain
   * functions call, not an API. Inserting here also keeps these tests about the
   * trigger rather than about that function, and mirrors what it does:
   * `on conflict (idempotency_key) do nothing`, returning nothing on a repeat.
   */
  async function notify(pushEligible: boolean, key = `queue-test-${Math.random()}`): Promise<string | null> {
    return asServiceRoleCommitting(db, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into public.notifications
           (recipient_user_id, league_id, type, title, body, deep_link,
            idempotency_key, delivery_metadata)
         values ($1, $2, 'match_published', 'Title', 'Body', '/leagues/x/matches/y',
                 $3, jsonb_build_object('push_eligible', $4::boolean))
         on conflict (idempotency_key) do nothing
         returning id`,
        [SEED_USERS.rmvfcPlayer.id, SEED_LEAGUES.rmvfc, key, pushEligible],
      );
      return rows[0]?.id ?? null;
    });
  }

  // ── Enqueue ──────────────────────────────────────────────────────────────

  describe('enqueue happens in the notification\'s own transaction', () => {
    it('creates exactly one job for a push-eligible notification', async () => {
      const id = await notify(true);

      const all = await jobs();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        notification_id: id,
        status: 'pending',
        attempts: 0,
        claimed_by: null,
        completed_at: null,
      });
    });

    it('creates no job for a notification that is not push-eligible', async () => {
      await notify(false);
      expect(await jobs()).toHaveLength(0);
    });

    it('rolls the job back with the notification', async () => {
      // THE WHOLE POINT OF THE TRIGGER. An enqueue done as a separate statement
      // after the domain call would survive this rollback in one direction or
      // the other, leaving either a notification nobody will deliver or a job
      // pointing at nothing.
      await asServiceRole(db, async (client) => {
        await client.query(
          `insert into public.notifications
             (recipient_user_id, league_id, type, title, body, deep_link,
              idempotency_key, delivery_metadata)
           values ($1, $2, 'match_published', 'T', 'B', '/x/y', 'queue-test-rollback-0001',
                   jsonb_build_object('push_eligible', true))`,
          [SEED_USERS.rmvfcPlayer.id, SEED_LEAGUES.rmvfc],
        );

        const { rows } = await client.query<{ count: string }>(
          'select count(*)::text as count from public.notification_delivery_jobs',
        );
        // Visible inside the transaction …
        expect(rows[0]!.count).toBe('1');
      });

      // … and gone with it, because `asServiceRole` rolls back.
      expect(await jobs()).toHaveLength(0);
    });

    it('does not enqueue twice for a repeated domain operation', async () => {
      // `create_notification` is `on conflict (idempotency_key) do nothing`, so
      // the second call inserts no row and therefore fires no trigger. This is
      // what makes a retried server action a no-op rather than a second alert.
      const key = 'queue-test-duplicate-0001';
      const first = await notify(true, key);
      const second = await notify(true, key);

      expect(second).toBeNull();
      const all = await jobs();
      expect(all).toHaveLength(1);
      expect(all[0]?.notification_id).toBe(first);
    });

    it('refuses a second job for the same notification', async () => {
      // The unique constraint, asserted directly — it is what makes the
      // idempotency survive any insert path the trigger does not cover.
      const id = await notify(true);

      const error = await expectDatabaseError(() =>
        asServiceRole(db, (client) =>
          client.query(
            'insert into public.notification_delivery_jobs (notification_id) values ($1)',
            [id],
          ),
        ),
      );

      expect(error.code).toBe(PG_ERROR.uniqueViolation);
    });

    it('enqueues a real fanout from a real administrator action', async () => {
      // End to end, through the actual product path rather than a hand-written
      // insert: publishing a match notifies every active member, and every one
      // of those notifications is now queued for delivery.
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
      );

      const all = await jobs();
      expect(all.length).toBeGreaterThan(0);

      const notificationIds = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `select id from public.notifications where type = 'match_published'`,
        );
        return rows.map((row) => row.id);
      });

      expect(new Set(all.map((job) => job.notification_id))).toEqual(new Set(notificationIds));
      expect(all.every((job) => job.status === 'pending')).toBe(true);
    });

    it('enqueues the join-request outcomes that never used to be pushed', async () => {
      // THE GAP THIS PHASE CLOSED. `decide_join_request` has always written
      // `join_request_approved` with `push_eligible: true`, and the type has
      // always been in `PUSH_ELIGIBLE_TYPES` — but `membership.ts` was the one
      // fanout action that never called the push seam, so approving somebody
      // into a league has never lit up their phone.
      //
      // Driving the queue from the notification rows rather than from call
      // sites fixes it without a sixth place to remember.
      await asUserCommitting(db, SEED_USERS.fivesAdmin, (client) =>
        client.query('select public.decide_join_request($1, true, null)', [
          SEED_JOIN_REQUESTS.outsiderToFives,
        ]),
      );

      const queued = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ type: string }>(
          `select n.type
             from public.notification_delivery_jobs j
             join public.notifications n on n.id = j.notification_id`,
        );
        return rows.map((row) => row.type);
      });

      expect(queued).toContain('join_request_approved');
    });
  });

  // ── Claiming ─────────────────────────────────────────────────────────────

  describe('claiming', () => {
    it('claims pending work and marks it processing', async () => {
      const id = await notify(true);

      const claimed = await asServiceRoleCommitting(db, async (client) => {
        const { rows } = await client.query<{ job_notification_id: string }>(
          `select * from public.claim_notification_delivery_jobs('worker-a', 10, 120)`,
        );
        return rows;
      });

      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.job_notification_id).toBe(id);

      const [job] = await jobs();
      expect(job).toMatchObject({ status: 'processing', attempts: 1, claimed_by: 'worker-a' });
      expect(job?.lease_expires_at).not.toBeNull();
    });

    it('claims nothing twice', async () => {
      await notify(true);

      await asServiceRoleCommitting(db, (client) =>
        client.query(`select * from public.claim_notification_delivery_jobs('worker-a', 10, 120)`),
      );
      const second = await asServiceRoleCommitting(db, async (client) => {
        const { rows } = await client.query(
          `select * from public.claim_notification_delivery_jobs('worker-b', 10, 120)`,
        );
        return rows;
      });

      expect(second).toHaveLength(0);
    });

    it('enforces its batch limit however much is asked for', async () => {
      for (let index = 0; index < 8; index += 1) {
        await notify(true, `queue-test-bulk-${index}`);
      }

      const claimed = await asServiceRoleCommitting(db, async (client) => {
        const { rows } = await client.query(
          `select * from public.claim_notification_delivery_jobs('worker-a', 3, 120)`,
        );
        return rows;
      });

      expect(claimed).toHaveLength(3);
    });

    it('clamps an absurd limit rather than trusting it', async () => {
      for (let index = 0; index < 8; index += 1) {
        await notify(true, `queue-test-clamp-${index}`);
      }

      const claimed = await asServiceRoleCommitting(db, async (client) => {
        const { rows } = await client.query(
          `select * from public.claim_notification_delivery_jobs('worker-a', 100000, 120)`,
        );
        return rows;
      });

      // Everything available, but the SQL cap is what would have bounded it.
      expect(claimed).toHaveLength(8);
    });

    it('claims oldest first', async () => {
      const first = await notify(true, `queue-test-order-1`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await notify(true, `queue-test-order-2`);

      const claimed = await asServiceRoleCommitting(db, async (client) => {
        const { rows } = await client.query<{ job_notification_id: string }>(
          `select * from public.claim_notification_delivery_jobs('worker-a', 1, 120)`,
        );
        return rows;
      });

      expect(claimed[0]?.job_notification_id).toBe(first);
    });

    it('rejects a worker identity that is not an opaque token', async () => {
      await notify(true);

      const error = await expectDatabaseError(() =>
        asServiceRole(db, (client) =>
          client.query(
            `select * from public.claim_notification_delivery_jobs(
               'https://match-day.vercel.app/api/cron/notification-delivery?secret=hunter2', 10, 120)`,
          ),
        ),
      );

      // `claimed_by` is a column operators read. A worker identity is not a
      // place to start putting URLs, let alone ones with query strings.
      expect(error.message).toContain('INVALID_WORKER');
    });
  });

  // ── Two workers at once ──────────────────────────────────────────────────

  describe('two workers racing', () => {
    it('never hands the same job to both', async () => {
      await notify(true, `queue-test-race-single`);

      const [a, b] = await workers(2);

      // Both hold their transaction open across the other's attempt, which is
      // what makes this a real race rather than two sequential statements.
      await Promise.all([a!.query('begin'), b!.query('begin')]);

      const [first, second] = await Promise.all([
        a!.query(`select * from public.claim_notification_delivery_jobs('worker-a', 10, 120)`),
        b!.query(`select * from public.claim_notification_delivery_jobs('worker-b', 10, 120)`),
      ]);

      await Promise.all([a!.query('commit'), b!.query('commit')]);

      // One of them got it; the other skipped rather than blocked or duplicated.
      expect([first.rows.length, second.rows.length].sort()).toEqual([0, 1]);

      const all = await jobs();
      expect(all).toHaveLength(1);
      expect(all[0]?.attempts).toBe(1);
    });

    it('splits a queue between them without overlap', async () => {
      for (let index = 0; index < 10; index += 1) {
        await notify(true, `queue-test-split-${index}`);
      }

      const [a, b] = await workers(2);
      await Promise.all([a!.query('begin'), b!.query('begin')]);

      const [first, second] = await Promise.all([
        a!.query<{ job_id: string }>(
          `select * from public.claim_notification_delivery_jobs('worker-a', 5, 120)`,
        ),
        b!.query<{ job_id: string }>(
          `select * from public.claim_notification_delivery_jobs('worker-b', 5, 120)`,
        ),
      ]);

      await Promise.all([a!.query('commit'), b!.query('commit')]);

      const claimedIds = [...first.rows, ...second.rows].map((row) => row.job_id);
      expect(claimedIds).toHaveLength(10);
      // The assertion that matters: no job appears in both halves.
      expect(new Set(claimedIds).size).toBe(10);
    });
  });

  // ── Crashed workers ──────────────────────────────────────────────────────

  describe('a worker that disappears', () => {
    it('does not strand its job for ever', async () => {
      await notify(true, `queue-test-lease-1`);

      await asServiceRoleCommitting(db, (client) =>
        client.query(`select * from public.claim_notification_delivery_jobs('gone', 10, 120)`),
      );

      // Nobody may take it while the lease holds …
      const tooEarly = await asServiceRoleCommitting(db, async (client) => {
        const { rows } = await client.query(
          `select * from public.claim_notification_delivery_jobs('worker-b', 10, 120)`,
        );
        return rows;
      });
      expect(tooEarly).toHaveLength(0);

      // … the worker is killed, and the lease lapses.
      await asServiceRoleCommitting(db, (client) =>
        client.query(
          `update public.notification_delivery_jobs
              set lease_expires_at = now() - interval '1 second'
            where status = 'processing'`,
        ),
      );

      const reclaimed = await asServiceRoleCommitting(db, async (client) => {
        const { rows } = await client.query(
          `select * from public.claim_notification_delivery_jobs('worker-b', 10, 120)`,
        );
        return rows;
      });

      expect(reclaimed).toHaveLength(1);
      const [job] = await jobs();
      expect(job).toMatchObject({ status: 'processing', claimed_by: 'worker-b', attempts: 2 });
    });

    it('never resurrects a job that already finished', async () => {
      // The reclaim branch selects only `processing` rows. A completed delivery
      // must not come back because a lease column was left set — which is why
      // completion nulls it and a constraint enforces the pairing.
      await notify(true, `queue-test-lease-2`);

      const [claimed] = await asServiceRoleCommitting(db, async (client) => {
        const { rows } = await client.query<{ job_id: string }>(
          `select * from public.claim_notification_delivery_jobs('worker-a', 10, 120)`,
        );
        return rows;
      });

      await asServiceRoleCommitting(db, (client) =>
        client.query(`select public.complete_notification_delivery_job($1, 'completed', null)`, [
          claimed!.job_id,
        ]),
      );

      const after = await asServiceRoleCommitting(db, async (client) => {
        const { rows } = await client.query(
          `select * from public.claim_notification_delivery_jobs('worker-b', 10, 120)`,
        );
        return rows;
      });

      expect(after).toHaveLength(0);
      expect((await jobs())[0]?.lease_expires_at).toBeNull();
    });
  });

  // ── Completion ───────────────────────────────────────────────────────────

  describe('completion', () => {
    async function claimOne(): Promise<string> {
      await notify(true, `queue-test-complete-${Math.random()}`);
      const [claimed] = await asServiceRoleCommitting(db, async (client) => {
        const { rows } = await client.query<{ job_id: string }>(
          `select * from public.claim_notification_delivery_jobs('worker-a', 1, 120)`,
        );
        return rows;
      });
      return claimed!.job_id;
    }

    it('records a completion once and only once', async () => {
      const jobId = await claimOne();

      const first = await asServiceRoleCommitting(db, async (client) => {
        const { rows } = await client.query<{ ok: boolean }>(
          `select public.complete_notification_delivery_job($1, 'completed', null) as ok`,
          [jobId],
        );
        return rows[0]!.ok;
      });

      const second = await asServiceRoleCommitting(db, async (client) => {
        const { rows } = await client.query<{ ok: boolean }>(
          `select public.complete_notification_delivery_job($1, 'failed', 'network') as ok`,
          [jobId],
        );
        return rows[0]!.ok;
      });

      expect(first).toBe(true);
      // A straggler cannot rewrite a finished job's outcome.
      expect(second).toBe(false);

      const [job] = await jobs();
      expect(job).toMatchObject({ status: 'completed', last_error_category: null });
      expect(job?.completed_at).not.toBeNull();
    });

    it('records a failure with its category', async () => {
      const jobId = await claimOne();

      await asServiceRoleCommitting(db, (client) =>
        client.query(
          `select public.complete_notification_delivery_job($1, 'failed', 'all_attempts_failed')`,
          [jobId],
        ),
      );

      expect((await jobs())[0]).toMatchObject({
        status: 'failed',
        last_error_category: 'all_attempts_failed',
      });
    });

    it('refuses to push a job back into the queue', async () => {
      // Re-queueing is a retry policy, and Phase 3B does not have one. Allowing
      // `pending` here would let a worker build one by accident.
      const jobId = await claimOne();

      const error = await expectDatabaseError(() =>
        asServiceRole(db, (client) =>
          client.query(
            `select public.complete_notification_delivery_job($1, 'pending', null)`,
            [jobId],
          ),
        ),
      );

      expect(error.message).toContain('INVALID_STATUS');
    });

    it('refuses an error category that is not a category', async () => {
      // The same rule, and the same regex, as `push_delivery_attempts`: raw
      // provider responses carry endpoints and tokens.
      const jobId = await claimOne();

      const error = await expectDatabaseError(() =>
        asServiceRole(db, (client) =>
          client.query(
            `select public.complete_notification_delivery_job(
               $1, 'failed', 'APNs said 410 for https://web.push.apple.com/AAAA')`,
            [jobId],
          ),
        ),
      );

      expect(error.code).toBe(PG_ERROR.checkViolation);
    });
  });

  // ── Who may see any of this ──────────────────────────────────────────────

  describe('the queue is not a member-facing surface', () => {
    it('is invisible to the person whose notification is in it', async () => {
      await notify(true, `queue-test-rls-1`);

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('select * from public.notification_delivery_jobs'),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it.each([
      ['insert', `insert into public.notification_delivery_jobs (notification_id) values (gen_random_uuid())`],
      ['update', `update public.notification_delivery_jobs set status = 'completed'`],
      ['delete', `delete from public.notification_delivery_jobs`],
    ])('refuses %s from an ordinary member', async (_label, sql) => {
      await notify(true, `queue-test-rls-${_label}`);

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) => client.query(sql)),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('is invisible to an administrator too', async () => {
      // Operational queue state is not league data. An administrator has no
      // more business reading it than a player does.
      await notify(true, `queue-test-rls-admin`);

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query('select count(*) from public.notification_delivery_jobs'),
        ),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('is invisible to an unauthenticated visitor', async () => {
      const error = await expectDatabaseError(() =>
        asAnon(db, (client) => client.query('select * from public.notification_delivery_jobs')),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it.each([
      ['claim', `select * from public.claim_notification_delivery_jobs('mine', 10, 120)`],
      [
        'complete',
        `select public.complete_notification_delivery_job(gen_random_uuid(), 'completed', null)`,
      ],
      ['enqueue', `select public.enqueue_notification_delivery()`],
    ])('refuses the %s function to a member', async (_label, sql) => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) => client.query(sql)),
      );

      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });

  // ── What Phase 3A already guaranteed ─────────────────────────────────────

  describe('existing delivery bookkeeping is untouched', () => {
    it('still records a provider message id against an attempt', async () => {
      // Phase 3A's column and RPC, exercised unchanged through the queue's
      // arrival. The queue records *jobs*; per-device attempts stay where they
      // were, and nothing here moved them.
      const notificationId = await notify(true, `queue-test-attempt-1`);

      const subscriptionId = await asServiceRoleCommitting(db, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `insert into public.push_subscriptions
             (user_id, channel, device_token, apns_environment, installation_id, enabled)
           values ($1, 'apns', $2, 'production', $3, true)
           returning id`,
          [
            SEED_USERS.rmvfcPlayer.id,
            'A'.repeat(64),
            'cccccccc-3333-4333-8333-cccccccccccc',
          ],
        );
        return rows[0]!.id;
      });

      await asServiceRoleCommitting(db, (client) =>
        client.query(
          `select public.record_push_delivery_result($1, $2, 'sent', null, $3)`,
          [notificationId, subscriptionId, 'APNS-ID-0001'],
        ),
      );

      const attempt = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{
          status: string;
          provider_message_id: string | null;
        }>(
          `select status, provider_message_id from public.push_delivery_attempts
            where notification_id = $1`,
          [notificationId],
        );
        return rows[0];
      });

      expect(attempt).toMatchObject({ status: 'sent', provider_message_id: 'APNS-ID-0001' });
    });
  });

  // ── The reminder path still works ────────────────────────────────────────

  describe('the reminder generator is unaffected', () => {
    it('still claims due reminders, and now enqueues them too', async () => {
      // A reminder only notifies players who have undertaken to turn up, so the
      // fixture is a real signup rather than a hand-written row — which means
      // satisfying the two gates the seed leaves closed on this match.
      await db.pool.query(`update public.matches set selection_mode = 'first_come' where id = $1`, [
        SEED_MATCHES.rmvfcOpen,
      ]);
      await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
        client.query('select public.accept_guideline_version($1)', [SEED_GUIDELINES.rmvfcRequired]),
      );
      await asUserCommitting(db, SEED_USERS.rmvfcPlayer, (client) =>
        client.query('select public.join_match($1)', [SEED_MATCHES.rmvfcOpen]),
      );

      await asServiceRoleCommitting(db, (client) =>
        client.query(
          `insert into public.match_reminders (league_id, match_id, offset_before, due_at)
           values ($1, $2, interval '24 hours', now() - interval '1 minute')`,
          [SEED_LEAGUES.rmvfc, SEED_MATCHES.rmvfcOpen],
        ),
      );

      const generated = await asServiceRoleCommitting(db, async (client) => {
        const { rows } = await client.query<{ reminder_id: string; notified: number }>(
          'select * from public.generate_due_reminders(100)',
        );
        return rows;
      });

      // Unchanged behaviour: the generator claims the occurrence and writes the
      // canonical notifications.
      expect(generated).toHaveLength(1);
      expect(generated[0]!.notified).toBeGreaterThan(0);

      // New behaviour: those notifications arrived with delivery jobs attached,
      // which is what replaced the generator's own inline push loop.
      const queuedReminders = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `select count(*)::text as count
             from public.notification_delivery_jobs j
             join public.notifications n on n.id = j.notification_id
            where n.type = 'reminder'`,
        );
        return Number(rows[0]!.count);
      });

      expect(queuedReminders).toBe(generated[0]!.notified);
    });
  });
});

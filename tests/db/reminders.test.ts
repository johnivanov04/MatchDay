import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asServiceRoleCommitting,
  asUser,
  asUserCommitting,
  createExtraMembers,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_LEAGUES,
  SEED_MATCHES,
  SEED_USERS,
  type ExtraMember,
  type TestDatabase,
} from './helpers/harness';

/**
 * Phase 5J — reminders.
 *
 * The whole mechanism is a pull: something outside the database asks "what is
 * due?" on a cadence. There is no timer anywhere, because a `setTimeout` dies
 * with the process and a process-local timer fires once per running instance.
 */
describe('reminders', () => {
  let db: TestDatabase;
  let members: ExtraMember[];

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
    await db.pool.query(
      `update public.matches set capacity = 4, min_players = 1,
                                 reminder_offsets = array[interval '2 hours', interval '1 day']
        where id = $1`,
      [SEED_MATCHES.fivesOpen],
    );
    members = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 3);
  });

  afterEach(async () => {
    await db.drop();
  });

  async function materialize(matchId = SEED_MATCHES.fivesOpen) {
    const { rows } = await db.pool.query<{ count: number }>(
      'select public.materialize_match_reminders($1) as count',
      [matchId],
    );
    return rows[0]?.count ?? 0;
  }

  async function generate() {
    return asServiceRoleCommitting(db, async (client) => {
      const result = await client.query<{ reminder_id: string; notified: number }>(
        'select * from public.generate_due_reminders()',
      );
      return result.rows;
    });
  }

  async function makeDue(offset = '2 hours') {
    await db.pool.query(
      `update public.match_reminders set due_at = now() - interval '1 minute'
        where match_id = $1 and offset_before = $2::interval`,
      [SEED_MATCHES.fivesOpen, offset],
    );
  }

  async function reminderNotifications() {
    const { rows } = await db.pool.query<{
      recipient_user_id: string;
      idempotency_key: string;
      title: string;
      body: string;
    }>(
      `select recipient_user_id, idempotency_key, title, body from public.notifications
        where type = 'reminder' order by idempotency_key`,
    );
    return rows;
  }

  async function confirmOne(member: ExtraMember) {
    await asUserCommitting(db, member.user, (client) =>
      client.query('select * from public.join_match($1)', [SEED_MATCHES.fivesOpen]),
    );
  }

  describe('materialising', () => {
    it('resolves each offset into a concrete instant from the stored kickoff', async () => {
      expect(await materialize()).toBe(2);

      const { rows } = await db.pool.query<{ matches_kickoff: boolean }>(
        `select bool_and(r.due_at = m.kickoff_at - r.offset_before) as matches_kickoff
           from public.match_reminders r join public.matches m on m.id = r.match_id
          where r.match_id = $1`,
        [SEED_MATCHES.fivesOpen],
      );
      // Derived from the match's own absolute timestamp, so nothing here
      // re-runs a recurrence rule or a timezone conversion.
      expect(rows[0]?.matches_kickoff).toBe(true);
    });

    it('is idempotent, so republishing creates no second copy', async () => {
      await materialize();
      expect(await materialize()).toBe(0);

      const { rows } = await db.pool.query<{ count: string }>(
        'select count(*)::text as count from public.match_reminders where match_id = $1',
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows[0]?.count).toBe('2');
    });

    it('skips an offset that is already in the past', async () => {
      await db.pool.query(
        `update public.matches set reminder_offsets = array[interval '400 days']
          where id = $1`,
        [SEED_MATCHES.fivesOpen],
      );
      // A match published inside its own reminder window should not immediately
      // fire a "next week" reminder.
      expect(await materialize()).toBe(0);
    });

    it('happens automatically when a match is published', async () => {
      await db.pool.query(
        `update public.matches set reminder_offsets = array[interval '3 hours']
          where id = $1`,
        [SEED_MATCHES.rmvfcDraft],
      );
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
      );

      const { rows } = await db.pool.query<{ count: string }>(
        'select count(*)::text as count from public.match_reminders where match_id = $1',
        [SEED_MATCHES.rmvfcDraft],
      );
      expect(rows[0]?.count).toBe('1');
    });
  });

  describe('generating', () => {
    it('sends nothing before the due time', async () => {
      await materialize();
      await confirmOne(members[0]!);

      expect(await generate()).toEqual([]);
      expect(await reminderNotifications()).toEqual([]);
    });

    it('sends once at the due time, to each confirmed player', async () => {
      await materialize();
      await confirmOne(members[0]!);
      await confirmOne(members[1]!);
      await makeDue();

      const claimed = await generate();
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.notified).toBe(2);

      const notifications = await reminderNotifications();
      expect(notifications).toHaveLength(2);
      expect(new Set(notifications.map((row) => row.recipient_user_id)).size).toBe(2);
    });

    it('sends once after the due time, not once per run', async () => {
      await materialize();
      await confirmOne(members[0]!);
      await db.pool.query(
        `update public.match_reminders set due_at = now() - interval '3 hours'
          where match_id = $1 and offset_before = interval '2 hours'`,
        [SEED_MATCHES.fivesOpen],
      );

      expect((await generate()).length).toBe(1);
      expect((await generate()).length).toBe(0);
      expect(await reminderNotifications()).toHaveLength(1);
    });

    it('creates no duplicate when run repeatedly', async () => {
      await materialize();
      await confirmOne(members[0]!);
      await makeDue();

      for (let run = 0; run < 5; run += 1) {
        await generate();
      }
      expect(await reminderNotifications()).toHaveLength(1);
    });

    it('records the claim on the reminder row', async () => {
      await materialize();
      await confirmOne(members[0]!);
      await makeDue();
      await generate();

      const { rows } = await db.pool.query<{
        generated_at: string | null;
        notified_count: number | null;
      }>(
        `select generated_at, notified_count from public.match_reminders
          where match_id = $1 and offset_before = interval '2 hours'`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows[0]?.generated_at).not.toBeNull();
      expect(rows[0]?.notified_count).toBe(1);
    });

    it('keys each notification on the reminder occurrence and the recipient', async () => {
      await materialize();
      await confirmOne(members[0]!);
      await makeDue();
      await generate();

      const { rows } = await db.pool.query<{ id: string }>(
        `select id from public.match_reminders
          where match_id = $1 and offset_before = interval '2 hours'`,
        [SEED_MATCHES.fivesOpen],
      );
      const notifications = await reminderNotifications();
      expect(notifications[0]?.idempotency_key).toBe(
        `reminder:${rows[0]!.id}:${members[0]!.membershipId}`,
      );
    });

    it('sends nothing for a canceled match', async () => {
      await materialize();
      await confirmOne(members[0]!);
      await makeDue();
      await asUserCommitting(db, SEED_USERS.fivesAdmin, (client) =>
        client.query('select public.cancel_match($1)', [SEED_MATCHES.fivesOpen]),
      );

      // Members were told it was canceled; reminding them to turn up would be
      // worse than silence.
      expect(await generate()).toEqual([]);
      expect(await reminderNotifications()).toEqual([]);
    });

    it('sends nothing once kickoff has passed', async () => {
      await materialize();
      await confirmOne(members[0]!);
      await makeDue();
      // Every deadline moves with it; the schema requires them to sit at or
      // before kickoff.
      await db.pool.query(
        `update public.matches set kickoff_at = now() - interval '1 hour',
                                   arrival_at = now() - interval '2 hours',
                                   end_at = now() - interval '10 minutes',
                                   signup_closes_at = now() - interval '3 hours',
                                   cancellation_cutoff_at = now() - interval '4 hours',
                                   roster_publish_target_at = null,
                                   priority_window_ends_at = null
          where id = $1`,
        [SEED_MATCHES.fivesOpen],
      );

      // What a scheduler that had been down for a day would otherwise deliver.
      expect(await generate()).toEqual([]);
    });

    it('does not remind a member who is not confirmed', async () => {
      await materialize();
      await confirmOne(members[0]!);
      await asUserCommitting(db, members[1]!.user, (client) =>
        client.query('select * from public.mark_unavailable($1)', [SEED_MATCHES.fivesOpen]),
      );
      await makeDue();
      await generate();

      const notifications = await reminderNotifications();
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.recipient_user_id).toBe(members[0]!.user.id);
    });

    it('does not remind a suspended or removed member', async () => {
      await materialize();
      await confirmOne(members[0]!);
      await confirmOne(members[1]!);
      await db.pool.query(
        `update public.league_memberships set status = 'suspended' where id = $1`,
        [members[1]!.membershipId],
      );
      await makeDue();
      await generate();

      const notifications = await reminderNotifications();
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.recipient_user_id).toBe(members[0]!.user.id);
    });

    it('does not remind somebody who cancelled', async () => {
      await materialize();
      await confirmOne(members[0]!);
      await confirmOne(members[1]!);
      await asUserCommitting(db, members[1]!.user, (client) =>
        client.query('select * from public.cancel_spot($1)', [SEED_MATCHES.fivesOpen]),
      );
      await makeDue();
      await generate();

      expect(await reminderNotifications()).toHaveLength(1);
    });

    it('processes each configured offset as its own occurrence', async () => {
      await materialize();
      await confirmOne(members[0]!);

      await makeDue('2 hours');
      expect((await generate()).length).toBe(1);

      await makeDue('1 day');
      expect((await generate()).length).toBe(1);

      // Two reminders, two notifications, distinct keys.
      const notifications = await reminderNotifications();
      expect(notifications).toHaveLength(2);
      expect(new Set(notifications.map((row) => row.idempotency_key)).size).toBe(2);
    });

    it('carries no private detail in the reminder body', async () => {
      await materialize();
      await confirmOne(members[0]!);
      await confirmOne(members[1]!);
      await makeDue();
      await generate();

      const notifications = await reminderNotifications();
      const blob = notifications.map((row) => `${row.title} ${row.body}`).join(' ');
      // The match, its time and its location. Not who else is playing.
      for (const member of members) {
        expect(blob).not.toContain(member.membershipId);
        expect(blob).not.toContain(member.user.email);
      }
    });
  });

  describe('who may generate', () => {
    it('refuses a signed-in player', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, members[0]!.user, (client) =>
          client.query('select * from public.generate_due_reminders()'),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('refuses a league administrator', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.fivesAdmin, (client) =>
          client.query('select * from public.generate_due_reminders()'),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });

  describe('who may read the schedule', () => {
    it('lets the league administrator read it', async () => {
      await materialize();
      const rows = await asUser(db, SEED_USERS.fivesAdmin, async (client) => {
        const result = await client.query('select * from public.match_reminders');
        return result.rows;
      });
      expect(rows).toHaveLength(2);
    });

    it('hides it from a member', async () => {
      await materialize();
      const rows = await asUser(db, members[0]!.user, async (client) => {
        const result = await client.query('select * from public.match_reminders');
        return result.rows;
      });
      // A member sees the notification a reminder produces, not the schedule.
      expect(rows).toEqual([]);
    });

    it('hides another league’s schedule from its administrator', async () => {
      await materialize();
      const rows = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query('select * from public.match_reminders');
        return result.rows;
      });
      expect(rows).toEqual([]);
    });

    it('refuses a direct write by an administrator', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.fivesAdmin, (client) =>
          client.query(
            `insert into public.match_reminders (league_id, match_id, offset_before, due_at)
             values ($1, $2, interval '1 hour', now())`,
            [SEED_LEAGUES.weeknightFives, SEED_MATCHES.fivesOpen],
          ),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });
});

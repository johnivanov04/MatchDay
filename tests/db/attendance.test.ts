import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asUser,
  asUserCommitting,
  createExtraMembers,
  createTestDatabase,
  expectDatabaseError,
  SEED_LEAGUES,
  SEED_MATCHES,
  SEED_MEMBERSHIPS,
  SEED_USERS,
  type ExtraMember,
  type SeedUser,
  type TestDatabase,
} from './helpers/harness';

/**
 * Phase 7 — attendance.
 *
 * `fivesOpen` is a first-come match, which is what makes the confirmation paths
 * easy to exercise separately: players seat themselves, the administrator adds
 * and promotes, and the resulting attendance population has to contain all of
 * them regardless of how they got there.
 */
describe('attendance', () => {
  let db: TestDatabase;
  let members: ExtraMember[];

  const admin = SEED_USERS.fivesAdmin;
  const match = SEED_MATCHES.fivesOpen;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
    await db.pool.query(
      'update public.matches set capacity = 8, min_players = 1 where id = $1',
      [match],
    );
    members = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 8);
  });

  afterEach(async () => {
    await db.drop();
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Moves the whole match back in time. Every timestamp shifts by the same
   * interval, so the ordering constraints — arrival before kickoff, cutoff
   * before kickoff, signup close before kickoff — all still hold.
   */
  async function shiftMatchBy(interval: string) {
    await db.pool.query(
      `update public.matches
          set match_date = match_date - $2::interval,
              arrival_at = arrival_at - $2::interval,
              kickoff_at = kickoff_at - $2::interval,
              end_at = end_at - $2::interval,
              signup_closes_at = signup_closes_at - $2::interval,
              cancellation_cutoff_at = cancellation_cutoff_at - $2::interval,
              roster_publish_target_at = roster_publish_target_at - $2::interval
        where id = $1`,
      [match, interval],
    );
  }

  /** Far enough back that the match has ended. */
  const intoThePast = () => shiftMatchBy('10 days');

  async function callAs<T extends Record<string, unknown>>(
    user: SeedUser,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return asUserCommitting(db, user, async (client) => {
      const result = await client.query<T>(sql, params);
      return result.rows;
    });
  }

  async function join(member: ExtraMember) {
    await callAs(member.user, 'select public.join_match($1)', [match]);
  }

  /** The admin-approval equivalent: registers interest, awaiting a decision. */
  async function requestSpot(member: ExtraMember) {
    await callAs(member.user, 'select public.request_spot($1)', [match]);
  }

  async function cancel(member: ExtraMember, reason = 'Cannot make it') {
    await callAs(member.user, 'select public.cancel_spot($1, $2)', [match, reason]);
  }

  async function record(
    membershipId: string,
    outcome: string,
    note: string | null = null,
    expectedRevision: number | null = null,
  ) {
    const rows = await callAs<{ revision: number }>(
      admin,
      'select public.record_attendance($1, $2, $3::public.attendance_outcome, $4, $5) as revision',
      [match, membershipId, outcome, note, expectedRevision],
    );
    return rows[0]!.revision;
  }

  async function population(): Promise<string[]> {
    const { rows } = await db.pool.query<{ id: string }>(
      'select id from public.match_attendance_population($1) id order by id',
      [match],
    );
    return rows.map((row) => row.id).sort();
  }

  async function expectPopulation(expected: string[]) {
    expect(await population()).toEqual([...expected].sort());
  }

  // ══ The attendance population ═════════════════════════════════════════════
  //
  // Every route by which somebody becomes confirmed, and every route by which
  // somebody does not. This is the part of Phase 7 with no prior art in the
  // schema — `selected_at` looks like the answer and is not — so each path is
  // asserted on its own rather than through a single combined fixture.

  describe('who is eligible for an attendance record', () => {
    it('includes a first-come player who confirmed themselves', async () => {
      await join(members[0]!);

      await expectPopulation([members[0]!.membershipId]);
    });

    it('includes a player an administrator confirmed', async () => {
      await db.pool.query(
        `update public.matches set selection_mode = 'admin_approval' where id = $1`,
        [match],
      );
      await requestSpot(members[0]!);
      await callAs(admin, `select public.set_signup_decision($1, $2, 'confirmed')`, [
        match,
        members[0]!.membershipId,
      ]);

      await expectPopulation([members[0]!.membershipId]);
    });

    it('includes a player an administrator added manually', async () => {
      await callAs(admin, `select public.add_member_to_match($1, $2, 'confirmed')`, [
        match,
        members[0]!.membershipId,
      ]);

      await expectPopulation([members[0]!.membershipId]);
    });

    it('includes a player promoted automatically from the waitlist', async () => {
      await db.pool.query(
        `update public.matches set capacity = 2, waitlist_mode = 'automatic' where id = $1`,
        [match],
      );
      await join(members[0]!);
      await join(members[1]!);
      await join(members[2]!); // waitlisted
      await cancel(members[0]!);

      // The canceller stays in the population — they were confirmed and need an
      // outcome — and the promoted player joins it.
      await expectPopulation([
        members[0]!.membershipId,
        members[1]!.membershipId,
        members[2]!.membershipId,
      ]);
    });

    it('includes a player an administrator promoted from the waitlist', async () => {
      await db.pool.query(
        `update public.matches set capacity = 2, waitlist_mode = 'admin_controlled' where id = $1`,
        [match],
      );
      await join(members[0]!);
      await join(members[1]!);
      await join(members[2]!); // waitlisted
      await cancel(members[0]!);
      await callAs(admin, 'select public.promote_waitlisted_player($1, $2)', [
        match,
        members[2]!.membershipId,
      ]);

      await expectPopulation([
        members[0]!.membershipId,
        members[1]!.membershipId,
        members[2]!.membershipId,
      ]);
    });

    it('includes a confirmed player who then cancelled on time', async () => {
      await join(members[0]!);
      await cancel(members[0]!);

      const { rows } = await db.pool.query<{ status: string }>(
        'select status from public.match_signups where match_id = $1 and membership_id = $2',
        [match, members[0]!.membershipId],
      );
      expect(rows[0]!.status).toBe('canceled');

      await expectPopulation([members[0]!.membershipId]);
    });

    it('includes a confirmed player who then cancelled late', async () => {
      await join(members[0]!);
      // Move only the cutoff into the past, so the cancellation is late while
      // the match itself is still ahead.
      await db.pool.query(
        `update public.matches set cancellation_cutoff_at = now() - interval '1 hour'
          where id = $1`,
        [match],
      );
      await cancel(members[0]!);

      const { rows } = await db.pool.query<{ status: string }>(
        'select status from public.match_signups where match_id = $1 and membership_id = $2',
        [match, members[0]!.membershipId],
      );
      expect(rows[0]!.status).toBe('withdrawn_late');

      await expectPopulation([members[0]!.membershipId]);
    });

    it('excludes somebody who was only ever on the waitlist and withdrew', async () => {
      await db.pool.query('update public.matches set capacity = 2 where id = $1', [match]);
      await join(members[0]!);
      await join(members[1]!);
      await join(members[2]!); // waitlisted, never confirmed
      await cancel(members[2]!);

      // Their signup status is `canceled` — identical to the confirmed player
      // who withdrew — which is exactly why status cannot define the population.
      const { rows } = await db.pool.query<{ status: string }>(
        'select status from public.match_signups where match_id = $1 and membership_id = $2',
        [match, members[2]!.membershipId],
      );
      expect(rows[0]!.status).toBe('canceled');

      await expectPopulation([members[0]!.membershipId, members[1]!.membershipId]);
    });

    it('excludes somebody still on the waitlist at kickoff', async () => {
      await db.pool.query('update public.matches set capacity = 2 where id = $1', [match]);
      await join(members[0]!);
      await join(members[1]!);
      await join(members[2]!); // waitlisted, and stays there

      await expectPopulation([members[0]!.membershipId, members[1]!.membershipId]);
    });

    it('excludes an interested player who was never selected', async () => {
      await db.pool.query(
        `update public.matches set selection_mode = 'admin_approval' where id = $1`,
        [match],
      );
      await requestSpot(members[0]!);
      await requestSpot(members[1]!);
      await callAs(admin, `select public.set_signup_decision($1, $2, 'confirmed')`, [
        match,
        members[0]!.membershipId,
      ]);

      await expectPopulation([members[0]!.membershipId]);
    });

    it('excludes a player an administrator explicitly did not select', async () => {
      await db.pool.query(
        `update public.matches set selection_mode = 'admin_approval' where id = $1`,
        [match],
      );
      await requestSpot(members[0]!);
      await callAs(admin, `select public.set_signup_decision($1, $2, 'not_selected')`, [
        match,
        members[0]!.membershipId,
      ]);

      await expectPopulation([]);
    });

    it('excludes somebody who never responded at all', async () => {
      await expectPopulation([]);
    });

    it('keeps the first confirmation instant when a player is confirmed twice', async () => {
      await join(members[0]!);
      const { rows: first } = await db.pool.query<{ confirmed_at: string }>(
        `select confirmed_at::text from public.match_signups
          where match_id = $1 and membership_id = $2`,
        [match, members[0]!.membershipId],
      );

      await cancel(members[0]!);
      await callAs(admin, `select public.add_member_to_match($1, $2, 'confirmed')`, [
        match,
        members[0]!.membershipId,
      ]);

      const { rows: second } = await db.pool.query<{ confirmed_at: string }>(
        `select confirmed_at::text from public.match_signups
          where match_id = $1 and membership_id = $2`,
        [match, members[0]!.membershipId],
      );
      expect(second[0]!.confirmed_at).toBe(first[0]!.confirmed_at);
    });

    it('does not clear the marker when a player cancels', async () => {
      await join(members[0]!);
      await cancel(members[0]!);

      const { rows } = await db.pool.query<{ confirmed_at: string | null }>(
        `select confirmed_at::text from public.match_signups
          where match_id = $1 and membership_id = $2`,
        [match, members[0]!.membershipId],
      );
      expect(rows[0]!.confirmed_at).not.toBeNull();
    });
  });

  // ══ Recording ════════════════════════════════════════════════════════════

  describe('recording an outcome', () => {
    beforeEach(async () => {
      await join(members[0]!);
      await join(members[1]!);
    });

    it('refuses to record anything before the match has ended', async () => {
      const error = await expectDatabaseError(() =>
        record(members[0]!.membershipId, 'attended'),
      );
      expect(error.message).toContain('ATTENDANCE_NOT_OPEN');
    });

    it('refuses while the match is under way', async () => {
      // Kicked off, not yet finished.
      await db.pool.query(
        `update public.matches
            set arrival_at = now() - interval '90 minutes',
                kickoff_at = now() - interval '60 minutes',
                end_at = now() + interval '30 minutes',
                signup_closes_at = now() - interval '60 minutes',
                cancellation_cutoff_at = now() - interval '60 minutes'
          where id = $1`,
        [match],
      );

      const error = await expectDatabaseError(() =>
        record(members[0]!.membershipId, 'attended'),
      );
      expect(error.message).toContain('ATTENDANCE_NOT_OPEN');
    });

    it('records each of the five outcomes once the match has ended', async () => {
      await intoThePast();

      expect(await record(members[0]!.membershipId, 'attended')).toBe(1);
      expect(await record(members[1]!.membershipId, 'no_show')).toBe(1);

      const { rows } = await db.pool.query<{ membership_id: string; outcome: string }>(
        'select membership_id, outcome from public.attendance_records where match_id = $1',
        [match],
      );
      expect(new Map(rows.map((r) => [r.membership_id, r.outcome]))).toEqual(
        new Map([
          [members[0]!.membershipId, 'attended'],
          [members[1]!.membershipId, 'no_show'],
        ]),
      );
    });

    it('refuses an outcome for somebody who was never confirmed', async () => {
      await db.pool.query('update public.matches set capacity = 2 where id = $1', [match]);
      await join(members[2]!); // waitlisted
      await intoThePast();

      const error = await expectDatabaseError(() =>
        record(members[2]!.membershipId, 'no_show'),
      );
      expect(error.message).toContain('ATTENDANCE_NOT_ELIGIBLE');
    });

    it('refuses to mark a player who withdrew as having attended', async () => {
      await cancel(members[0]!);
      await intoThePast();

      const error = await expectDatabaseError(() =>
        record(members[0]!.membershipId, 'attended'),
      );
      expect(error.message).toContain('ATTENDANCE_OUTCOME_INVALID');
    });

    it('refuses to mark a player who withdrew as a no-show', async () => {
      await cancel(members[0]!);
      await intoThePast();

      const error = await expectDatabaseError(() =>
        record(members[0]!.membershipId, 'no_show'),
      );
      expect(error.message).toContain('ATTENDANCE_OUTCOME_INVALID');
    });

    it('allows an excused absence for a player who withdrew', async () => {
      await cancel(members[0]!);
      await intoThePast();

      expect(await record(members[0]!.membershipId, 'excused_absence')).toBe(1);
    });

    it('refuses to record a cancellation for a player who never cancelled', async () => {
      await intoThePast();

      const error = await expectDatabaseError(() =>
        record(members[0]!.membershipId, 'canceled_on_time'),
      );
      expect(error.message).toContain('ATTENDANCE_OUTCOME_INVALID');
    });

    it('suggests the outcome that matches how the player left', async () => {
      const { rows } = await db.pool.query<{ status: string; suggested: string | null }>(
        `select s.status,
                public.suggested_attendance_outcome(s.status)::text as suggested
           from unnest(array['confirmed', 'canceled', 'withdrawn_late', 'waitlisted']
                       ::public.signup_status[]) as s(status)`,
      );
      expect(new Map(rows.map((r) => [r.status, r.suggested]))).toEqual(
        new Map([
          ['confirmed', null],
          ['canceled', 'canceled_on_time'],
          ['withdrawn_late', 'canceled_late'],
          ['waitlisted', null],
        ]),
      );
    });

    it('never suggests a no-show, however the player left', async () => {
      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n
           from unnest(enum_range(null::public.signup_status)) as s(status)
          where public.suggested_attendance_outcome(s.status) = 'no_show'`,
      );
      expect(rows[0]!.n).toBe('0');
    });

    it('stores the administrator note', async () => {
      await intoThePast();
      await record(members[0]!.membershipId, 'no_show', '  Told me afterwards  ');

      const { rows } = await db.pool.query<{ note: string }>(
        'select note from public.attendance_records where match_id = $1 and membership_id = $2',
        [match, members[0]!.membershipId],
      );
      expect(rows[0]!.note).toBe('Told me afterwards');
    });

    it('refuses a caller who is not the league administrator', async () => {
      await intoThePast();

      const error = await expectDatabaseError(() =>
        callAs(
          members[1]!.user,
          `select public.record_attendance($1, $2, 'attended')`,
          [match, members[0]!.membershipId],
        ),
      );
      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
    });

    it('refuses an administrator of a different league', async () => {
      await intoThePast();

      const error = await expectDatabaseError(() =>
        callAs(
          SEED_USERS.rmvfcAdmin,
          `select public.record_attendance($1, $2, 'attended')`,
          [match, members[0]!.membershipId],
        ),
      );
      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
    });

    it('refuses attendance for a canceled match', async () => {
      await intoThePast();
      await db.pool.query(
        `update public.matches
            set status = 'canceled', canceled_at = now(), cancellation_reason = 'Waterlogged'
          where id = $1`,
        [match],
      );

      const error = await expectDatabaseError(() =>
        record(members[0]!.membershipId, 'attended'),
      );
      expect(error.message).toContain('ATTENDANCE_NOT_OPEN');
    });
  });

  // ══ Corrections ══════════════════════════════════════════════════════════

  describe('correcting a record', () => {
    beforeEach(async () => {
      await join(members[0]!);
      await intoThePast();
    });

    it('bumps the revision and keeps one current row', async () => {
      expect(await record(members[0]!.membershipId, 'no_show')).toBe(1);
      expect(await record(members[0]!.membershipId, 'attended')).toBe(2);

      const { rows } = await db.pool.query<{ n: string; outcome: string }>(
        `select count(*)::text as n, max(outcome::text) as outcome
           from public.attendance_records where match_id = $1 and membership_id = $2`,
        [match, members[0]!.membershipId],
      );
      expect(rows[0]!.n).toBe('1');
      expect(rows[0]!.outcome).toBe('attended');
    });

    it('records who corrected it and when', async () => {
      await record(members[0]!.membershipId, 'no_show');
      await record(members[0]!.membershipId, 'excused_absence');

      const { rows } = await db.pool.query<{
        recorded_by: string;
        corrected_by: string | null;
        corrected_at: string | null;
      }>(
        `select recorded_by, corrected_by, corrected_at::text
           from public.attendance_records where match_id = $1 and membership_id = $2`,
        [match, members[0]!.membershipId],
      );
      expect(rows[0]!.recorded_by).toBe(admin.id);
      expect(rows[0]!.corrected_by).toBe(admin.id);
      expect(rows[0]!.corrected_at).not.toBeNull();
    });

    it('leaves the revision alone when nothing actually changed', async () => {
      expect(await record(members[0]!.membershipId, 'attended', 'Late but played')).toBe(1);
      expect(await record(members[0]!.membershipId, 'attended', 'Late but played')).toBe(1);
    });

    it('refuses a correction based on a stale revision', async () => {
      await record(members[0]!.membershipId, 'no_show');
      await record(members[0]!.membershipId, 'attended'); // now revision 2

      const error = await expectDatabaseError(() =>
        record(members[0]!.membershipId, 'excused_absence', null, 1),
      );
      expect(error.message).toContain('ATTENDANCE_REVISION_STALE');
    });

    it('accepts a correction that carries the current revision', async () => {
      await record(members[0]!.membershipId, 'no_show');

      expect(await record(members[0]!.membershipId, 'attended', null, 1)).toBe(2);
    });

    it('keeps every prior value in the audit history', async () => {
      await record(members[0]!.membershipId, 'no_show');
      await record(members[0]!.membershipId, 'excused_absence');
      await record(members[0]!.membershipId, 'attended');

      const { rows } = await db.pool.query<{ action: string; before: unknown; after: unknown }>(
        `select action, before_data as before, after_data as after
           from public.audit_events
          where entity_type = 'attendance' and entity_id = $1
          order by created_at, id`,
        [match],
      );
      expect(rows.map((r) => r.action)).toEqual([
        'attendance.recorded',
        'attendance.corrected',
        'attendance.corrected',
      ]);
      expect(rows.map((r) => (r.after as { outcome: string }).outcome)).toEqual([
        'no_show',
        'excused_absence',
        'attended',
      ]);
      expect(rows.slice(1).map((r) => (r.before as { outcome: string }).outcome)).toEqual([
        'no_show',
        'excused_absence',
      ]);
    });

    it('never puts the administrator note into the audit trail', async () => {
      await record(members[0]!.membershipId, 'no_show', 'Private explanation about a person');

      const { rows } = await db.pool.query<{ blob: string }>(
        `select coalesce(after_data, '{}')::text || coalesce(before_data, '{}')::text
                  || coalesce(reason, '') as blob
           from public.audit_events where entity_type = 'attendance'`,
      );
      expect(rows.every((r) => !r.blob.includes('Private explanation'))).toBe(true);
      expect(rows[0]!.blob).toContain('had_note');
    });
  });

  // ══ Notifications ════════════════════════════════════════════════════════

  describe('notifications', () => {
    beforeEach(async () => {
      await join(members[0]!);
      await intoThePast();
    });

    async function notifications() {
      const { rows } = await db.pool.query<{
        title: string;
        body: string;
        idempotency_key: string;
        delivery_metadata: { push_eligible?: boolean };
      }>(
        `select title, body, idempotency_key, delivery_metadata
           from public.notifications
          where type = 'attendance_recorded' and recipient_user_id = $1
          order by created_at, id`,
        [members[0]!.user.id],
      );
      return rows;
    }

    it('tells the player once when their attendance is first recorded', async () => {
      await record(members[0]!.membershipId, 'attended');

      const rows = await notifications();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.body).toContain('recorded as having played');
    });

    it('tells them again when the record is corrected', async () => {
      await record(members[0]!.membershipId, 'no_show');
      await record(members[0]!.membershipId, 'attended');

      const rows = await notifications();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.idempotency_key)).size).toBe(2);
    });

    it('does not tell them again when nothing changed', async () => {
      await record(members[0]!.membershipId, 'attended');
      await record(members[0]!.membershipId, 'attended');

      expect(await notifications()).toHaveLength(1);
    });

    it('never marks an attendance notification push-eligible', async () => {
      await record(members[0]!.membershipId, 'no_show');

      const rows = await notifications();
      expect(rows[0]!.delivery_metadata.push_eligible).toBe(false);
    });

    it('never places the administrator note in the notification', async () => {
      await record(members[0]!.membershipId, 'no_show', 'Told the group chat he overslept');

      const rows = await notifications();
      expect(rows[0]!.title + rows[0]!.body).not.toContain('overslept');
    });
  });

  // ══ What the player may see ══════════════════════════════════════════════

  describe('a player reading their own attendance', () => {
    beforeEach(async () => {
      await join(members[0]!);
      await join(members[1]!);
      await intoThePast();
      await record(members[0]!.membershipId, 'no_show', 'Administrator-only note');
      await record(members[1]!.membershipId, 'attended');
    });

    it('returns their own outcome', async () => {
      const rows = await asUser(db, members[0]!.user, async (client) => {
        const result = await client.query<{ outcome: string }>(
          'select outcome::text from public.my_attendance($1)',
          [match],
        );
        return result.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outcome).toBe('no_show');
    });

    it('returns nothing about anybody else', async () => {
      const rows = await asUser(db, members[0]!.user, async (client) => {
        const result = await client.query('select * from public.my_attendance($1)', [match]);
        return result.rows;
      });
      expect(rows).toHaveLength(1);
    });

    it('has no column through which the note could travel', async () => {
      const { rows } = await db.pool.query<{ columns: string }>(
        `select string_agg(p.name, ',') as columns
           from pg_proc f
           join lateral unnest(f.proargnames) with ordinality as p(name, ord) on true
          where f.proname in ('my_attendance', 'my_attendance_history')`,
      );
      expect(rows[0]!.columns).not.toContain('note');
    });

    it('cannot read the attendance table directly', async () => {
      const rows = await asUser(db, members[0]!.user, async (client) => {
        const result = await client.query('select * from public.attendance_records');
        return result.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('lists their own history for the league', async () => {
      const rows = await asUser(db, members[0]!.user, async (client) => {
        const result = await client.query<{ outcome: string; match_id: string }>(
          'select outcome::text, match_id from public.my_attendance_history($1)',
          [SEED_LEAGUES.weeknightFives],
        );
        return result.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outcome).toBe('no_show');
      expect(rows[0]!.match_id).toBe(match);
    });
  });

  // ══ Completion ═══════════════════════════════════════════════════════════

  describe('completing a match', () => {
    beforeEach(async () => {
      await join(members[0]!);
      await join(members[1]!);
    });

    async function complete(user: SeedUser = admin) {
      return callAs(user, 'select public.complete_match($1)', [match]);
    }

    it('refuses before the match has ended', async () => {
      const error = await expectDatabaseError(() => complete());
      expect(error.message).toContain('ATTENDANCE_NOT_OPEN');
    });

    it('refuses while any participant has no outcome', async () => {
      await intoThePast();
      await record(members[0]!.membershipId, 'attended');

      const error = await expectDatabaseError(() => complete());
      expect(error.message).toContain('ATTENDANCE_INCOMPLETE');
    });

    it('completes once every participant has an outcome', async () => {
      await intoThePast();
      await record(members[0]!.membershipId, 'attended');
      await record(members[1]!.membershipId, 'no_show');

      await complete();

      const { rows } = await db.pool.query<{
        status: string;
        completed_at: string | null;
        completed_by: string | null;
      }>('select status, completed_at::text, completed_by from public.matches where id = $1', [
        match,
      ]);
      expect(rows[0]!.status).toBe('completed');
      expect(rows[0]!.completed_at).not.toBeNull();
      expect(rows[0]!.completed_by).toBe(admin.id);
    });

    it('counts a withdrawn participant towards completeness', async () => {
      await cancel(members[1]!);
      await intoThePast();
      await record(members[0]!.membershipId, 'attended');

      const error = await expectDatabaseError(() => complete());
      expect(error.message).toContain('ATTENDANCE_INCOMPLETE');

      await record(members[1]!.membershipId, 'canceled_on_time');
      await complete();

      const { rows } = await db.pool.query<{ status: string }>(
        'select status from public.matches where id = $1',
        [match],
      );
      expect(rows[0]!.status).toBe('completed');
    });

    it('is idempotent', async () => {
      await intoThePast();
      await record(members[0]!.membershipId, 'attended');
      await record(members[1]!.membershipId, 'attended');

      await complete();
      await complete();

      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.audit_events where action = 'match.completed'`,
      );
      expect(rows[0]!.n).toBe('1');
    });

    it('refuses to complete a canceled match', async () => {
      await intoThePast();
      await db.pool.query(
        `update public.matches
            set status = 'canceled', canceled_at = now(), cancellation_reason = 'Frozen pitch'
          where id = $1`,
        [match],
      );

      const error = await expectDatabaseError(() => complete());
      expect(error.message).toContain('MATCH_NOT_OPEN');
    });

    it('does not require teams to have been published', async () => {
      await intoThePast();
      await record(members[0]!.membershipId, 'attended');
      await record(members[1]!.membershipId, 'attended');

      await complete();

      const { rows } = await db.pool.query<{ team_revision: number; status: string }>(
        'select team_revision, status from public.matches where id = $1',
        [match],
      );
      expect(rows[0]!.team_revision).toBe(0);
      expect(rows[0]!.status).toBe('completed');
    });

    it('refuses a caller who is not the league administrator', async () => {
      await intoThePast();

      const error = await expectDatabaseError(() => complete(members[0]!.user));
      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
    });

    it('cannot be moved back out of completed', async () => {
      await intoThePast();
      await record(members[0]!.membershipId, 'attended');
      await record(members[1]!.membershipId, 'attended');
      await complete();

      const error = await expectDatabaseError(() =>
        db.pool.query(`update public.matches set status = 'open' where id = $1`, [match]),
      );
      expect(error.message).toContain('MATCH_TRANSITION_INVALID');
    });

    it('still allows a correction after completion', async () => {
      await intoThePast();
      await record(members[0]!.membershipId, 'no_show');
      await record(members[1]!.membershipId, 'attended');
      await complete();

      expect(await record(members[0]!.membershipId, 'attended')).toBe(2);
    });
  });

  // ══ No-show context, and the absence of automatic discipline ═════════════

  describe('no-show context for the administrator', () => {
    async function summary(membershipIds: string[], user: SeedUser = admin) {
      return callAs<{
        membership_id: string;
        recorded_count: number;
        attended_count: number;
        no_show_count: number;
        last_no_show_at: Date | null;
      }>(user, 'select * from public.membership_attendance_summary($1, $2)', [
        SEED_LEAGUES.weeknightFives,
        membershipIds,
      ]);
    }

    it('counts recorded outcomes without judging them', async () => {
      await join(members[0]!);
      await intoThePast();
      await record(members[0]!.membershipId, 'no_show');

      const rows = await summary([members[0]!.membershipId]);
      expect(rows[0]).toMatchObject({
        recorded_count: 1,
        attended_count: 0,
        no_show_count: 1,
      });
      expect(rows[0]!.last_no_show_at).not.toBeNull();
    });

    it('returns zeroes for somebody with no attendance history', async () => {
      const rows = await summary([members[0]!.membershipId]);
      expect(rows[0]).toMatchObject({
        recorded_count: 0,
        attended_count: 0,
        no_show_count: 0,
        last_no_show_at: null,
      });
    });

    it('exposes counts and a date and nothing resembling a score', async () => {
      const { rows } = await db.pool.query<{ columns: string }>(
        `select string_agg(p.name, ',') as columns
           from pg_proc f
           join lateral unnest(f.proargnames) with ordinality as p(name, ord) on true
          where f.proname = 'membership_attendance_summary'`,
      );
      for (const forbidden of ['score', 'rating', 'rank', 'tier', 'reliability', 'level']) {
        expect(rows[0]!.columns).not.toContain(forbidden);
      }
    });

    it('is refused to a player', async () => {
      await join(members[0]!);
      await intoThePast();
      await record(members[0]!.membershipId, 'no_show');

      const rows = await summary([members[0]!.membershipId], members[1]!.user);
      expect(rows).toHaveLength(0);
    });

    it('is refused to an administrator of another league', async () => {
      await join(members[0]!);
      await intoThePast();
      await record(members[0]!.membershipId, 'no_show');

      const rows = await summary([members[0]!.membershipId], SEED_USERS.rmvfcAdmin);
      expect(rows).toHaveLength(0);
    });
  });

  // ══ 7K — the invariant ═══════════════════════════════════════════════════
  //
  // The one rule Phase 7 exists to keep. Twenty no-shows must leave the member
  // exactly as able to play as they were before the first one.

  describe('a no-show never disciplines anybody automatically', () => {
    /**
     * Records `count` no-shows for one member across `count` separate ended
     * matches in the same league, then reports what the database did about it.
     */
    async function noShowRepeatedly(member: ExtraMember, count: number) {
      for (let index = 0; index < count; index += 1) {
        const { rows } = await db.pool.query<{ id: string }>(
          `insert into public.matches (
             league_id, title, match_date, timezone, arrival_at, kickoff_at, end_at,
             location_name, capacity, min_players, selection_mode, waitlist_mode,
             signup_closes_at, cancellation_cutoff_at, roster_publish_target_at,
             status, published_at, created_by
           )
           select $1, 'Past match ' || $2::text,
                  (now() - ($2 || ' days')::interval)::date, l.timezone,
                  now() - ($2 || ' days')::interval - interval '30 minutes',
                  now() - ($2 || ' days')::interval,
                  now() - ($2 || ' days')::interval + interval '90 minutes',
                  'Recreation ground', 10, 1, 'first_come', 'automatic',
                  now() - ($2 || ' days')::interval,
                  now() - ($2 || ' days')::interval - interval '1 day',
                  now() - ($2 || ' days')::interval - interval '1 day',
                  'open', now() - interval '30 days', $3
             from public.leagues l where l.id = $1
           returning id`,
          [SEED_LEAGUES.weeknightFives, index + 1, admin.id],
        );
        const pastMatch = rows[0]!.id;

        await db.pool.query(
          `insert into public.match_signups
             (league_id, match_id, membership_id, status, responded_at)
           values ($1, $2, $3, 'confirmed', now())`,
          [SEED_LEAGUES.weeknightFives, pastMatch, member.membershipId],
        );

        await callAs(
          admin,
          `select public.record_attendance($1, $2, 'no_show')`,
          [pastMatch, member.membershipId],
        );
      }
    }

    it('leaves the membership active after twenty of them', async () => {
      await noShowRepeatedly(members[0]!, 20);

      const { rows } = await db.pool.query<{
        status: string;
        suspended_until: string | null;
        status_reason: string | null;
      }>(
        `select status, suspended_until::text, status_reason
           from public.league_memberships where id = $1`,
        [members[0]!.membershipId],
      );
      expect(rows[0]!.status).toBe('active');
      expect(rows[0]!.suspended_until).toBeNull();
      expect(rows[0]!.status_reason).toBeNull();
    });

    it('still lets them sign up for the next match', async () => {
      await noShowRepeatedly(members[0]!, 20);
      await join(members[0]!);

      const { rows } = await db.pool.query<{ status: string }>(
        'select status from public.match_signups where match_id = $1 and membership_id = $2',
        [match, members[0]!.membershipId],
      );
      expect(rows[0]!.status).toBe('confirmed');
    });

    it('does not put them behind anybody in the waitlist order', async () => {
      await noShowRepeatedly(members[0]!, 20);
      await db.pool.query('update public.matches set capacity = 2 where id = $1', [match]);

      await join(members[1]!);
      await join(members[2]!);
      await join(members[0]!); // first to be waitlisted, and stays first
      await join(members[3]!);

      const { rows } = await db.pool.query<{ membership_id: string; waitlist_position: number }>(
        `select membership_id, waitlist_position from public.match_signups
          where match_id = $1 and status = 'waitlisted' order by waitlist_position`,
        [match],
      );
      expect(rows[0]!.membership_id).toBe(members[0]!.membershipId);
    });

    it('writes no automatic membership or discipline event of any kind', async () => {
      await noShowRepeatedly(members[0]!, 20);

      const { rows } = await db.pool.query<{ action: string }>(
        `select distinct action from public.audit_events
          where league_id = $1 and action not like 'attendance.%'`,
        [SEED_LEAGUES.weeknightFives],
      );
      expect(rows.map((r) => r.action)).not.toContain('membership.status_changed');
    });

    it('has no column anywhere that accumulates a hidden score', async () => {
      const { rows } = await db.pool.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name
           from information_schema.columns
          where table_schema = 'public'
            and (column_name like '%score%' or column_name like '%rating%'
                 or column_name like '%rank%' or column_name like '%strike%'
                 or column_name like '%reliability%' or column_name like '%penalt%')`,
      );
      expect(rows).toEqual([]);
    });
  });

  // ══ Cross-league isolation ═══════════════════════════════════════════════

  describe('isolation', () => {
    it('refuses to record attendance for a match in another league', async () => {
      const error = await expectDatabaseError(() =>
        callAs(
          admin,
          `select public.record_attendance($1, $2, 'attended')`,
          [SEED_MATCHES.rmvfcOpen, SEED_MEMBERSHIPS.rmvfcAdmin],
        ),
      );
      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
    });

    it('shows an administrator nothing from another league in the workspace', async () => {
      const rows = await callAs(admin, 'select * from public.match_attendance_workspace($1)', [
        SEED_MATCHES.rmvfcOpen,
      ]);
      expect(rows).toHaveLength(0);
    });
  });
});

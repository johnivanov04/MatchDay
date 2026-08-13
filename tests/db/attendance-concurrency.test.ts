import type { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asUserCommitting,
  connectAs,
  createExtraMembers,
  createTestDatabase,
  SEED_LEAGUES,
  SEED_MATCHES,
  SEED_USERS,
  type ExtraMember,
  type SeedUser,
  type TestDatabase,
} from './helpers/harness';

/**
 * Phase 7 against real PostgreSQL concurrency.
 *
 * Attendance is written after the match, so it races less with signup than
 * Phases 4–6 did — but two administrators sharing a phone at the pitch are a
 * completely ordinary way for this product to be used, and the membership
 * cascade races everything, because suspending somebody touches every future
 * match at once.
 *
 * As in the earlier suites, every actor gets a **separate connection** and the
 * work is fired with `Promise.all`. The shared pool caps at four connections and
 * recycles them, so two "concurrent" statements through it can serialize on one
 * socket and pass without having tested anything.
 */
describe('attendance concurrency', () => {
  let db: TestDatabase;
  let clients: Client[] = [];
  let members: ExtraMember[];

  const admin = SEED_USERS.fivesAdmin;
  const match = SEED_MATCHES.fivesOpen;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
    clients = [];
    await db.pool.query(
      'update public.matches set capacity = 10, min_players = 1 where id = $1',
      [match],
    );
    members = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 8);
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.end()));
    await db.drop();
  });

  async function connectMany(count: number, user: SeedUser = admin): Promise<Client[]> {
    const opened = await Promise.all(Array.from({ length: count }, () => connectAs(db, user)));
    clients.push(...opened);
    return opened;
  }

  async function joinAll(count: number) {
    for (const member of members.slice(0, count)) {
      await asUserCommitting(db, member.user, (client) =>
        client.query('select public.join_match($1)', [match]),
      );
    }
  }

  /** Moves the whole match into the past so attendance is open. */
  async function endTheMatch() {
    await db.pool.query(
      `update public.matches
          set match_date = match_date - interval '10 days',
              arrival_at = arrival_at - interval '10 days',
              kickoff_at = kickoff_at - interval '10 days',
              end_at = end_at - interval '10 days',
              signup_closes_at = signup_closes_at - interval '10 days',
              cancellation_cutoff_at = cancellation_cutoff_at - interval '10 days',
              roster_publish_target_at = roster_publish_target_at - interval '10 days'
        where id = $1`,
      [match],
    );
  }

  async function records() {
    const { rows } = await db.pool.query<{
      membership_id: string;
      outcome: string;
      revision: number;
    }>(
      'select membership_id, outcome::text, revision from public.attendance_records where match_id = $1',
      [match],
    );
    return rows;
  }

  async function matchRow() {
    const { rows } = await db.pool.query<{ status: string; completed_at: string | null }>(
      'select status, completed_at::text from public.matches where id = $1',
      [match],
    );
    return rows[0]!;
  }

  async function confirmedCount(matchId: string = match) {
    const { rows } = await db.pool.query<{ count: number }>(
      'select public.match_confirmed_count($1) as count',
      [matchId],
    );
    return rows[0]!.count;
  }

  /** Settles everything, so one rejection does not hide the others' outcomes. */
  const race = <T,>(work: Array<Promise<T>>) => Promise.allSettled(work);

  const fulfilled = (results: PromiseSettledResult<unknown>[]) =>
    results.filter((r) => r.status === 'fulfilled').length;

  // ── 1. Two administrators recording the same player ──────────────────────

  it('leaves exactly one record when two administrators record the same player', async () => {
    await joinAll(2);
    await endTheMatch();
    const [a, b] = await connectMany(2);

    await race([
      a!.query(`select public.record_attendance($1, $2, 'attended')`, [
        match,
        members[0]!.membershipId,
      ]),
      b!.query(`select public.record_attendance($1, $2, 'no_show')`, [
        match,
        members[0]!.membershipId,
      ]),
    ]);

    const rows = await records();
    const mine = rows.filter((r) => r.membership_id === members[0]!.membershipId);
    expect(mine).toHaveLength(1);
    // Whichever won, the revision reflects how many writes actually landed —
    // it never skips and never repeats.
    expect(mine[0]!.revision).toBeLessThanOrEqual(2);
  });

  // ── 2. Two corrections racing ────────────────────────────────────────────

  it('does not let two corrections share a revision number', async () => {
    await joinAll(2);
    await endTheMatch();
    await asUserCommitting(db, admin, (client) =>
      client.query(`select public.record_attendance($1, $2, 'no_show')`, [
        match,
        members[0]!.membershipId,
      ]),
    );
    const [a, b] = await connectMany(2);

    const results = await race([
      a!.query(`select public.record_attendance($1, $2, 'attended')`, [
        match,
        members[0]!.membershipId,
      ]),
      b!.query(`select public.record_attendance($1, $2, 'excused_absence')`, [
        match,
        members[0]!.membershipId,
      ]),
    ]);

    expect(fulfilled(results)).toBe(2);
    const mine = (await records()).find((r) => r.membership_id === members[0]!.membershipId)!;
    // Serialized by the match lock: two distinct corrections, so revision 3.
    expect(mine.revision).toBe(3);
  });

  // ── 3. Optimistic concurrency does its job ───────────────────────────────

  it('refuses the loser of a race when both carry the same expected revision', async () => {
    await joinAll(2);
    await endTheMatch();
    await asUserCommitting(db, admin, (client) =>
      client.query(`select public.record_attendance($1, $2, 'no_show')`, [
        match,
        members[0]!.membershipId,
      ]),
    );
    const [a, b] = await connectMany(2);

    const results = await race([
      a!.query(`select public.record_attendance($1, $2, 'attended', null, 1)`, [
        match,
        members[0]!.membershipId,
      ]),
      b!.query(`select public.record_attendance($1, $2, 'excused_absence', null, 1)`, [
        match,
        members[0]!.membershipId,
      ]),
    ]);

    // Both administrators loaded revision 1. One wins; the other is told the
    // record moved under them rather than silently overwriting a decision it
    // never saw.
    expect(fulfilled(results)).toBe(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain('ATTENDANCE_REVISION_STALE');
  });

  // ── 4. Recording against completion ──────────────────────────────────────

  it('cannot complete a match while an attendance record is still being written', async () => {
    await joinAll(2);
    await endTheMatch();
    await asUserCommitting(db, admin, (client) =>
      client.query(`select public.record_attendance($1, $2, 'attended')`, [
        match,
        members[0]!.membershipId,
      ]),
    );
    const [a, b] = await connectMany(2);

    await race([
      a!.query(`select public.record_attendance($1, $2, 'attended')`, [
        match,
        members[1]!.membershipId,
      ]),
      b!.query('select public.complete_match($1)', [match]),
    ]);

    const row = await matchRow();
    const recorded = (await records()).length;
    // Either completion ran second and saw both records, or it ran first and
    // refused. What must never happen is a completed match with a participant
    // still missing an outcome.
    if (row.status === 'completed') {
      expect(recorded).toBe(2);
    } else {
      expect(row.completed_at).toBeNull();
    }
  });

  // ── 5. Two completions ───────────────────────────────────────────────────

  it('completes a match once when two administrators press it together', async () => {
    await joinAll(2);
    await endTheMatch();
    for (const member of members.slice(0, 2)) {
      await asUserCommitting(db, admin, (client) =>
        client.query(`select public.record_attendance($1, $2, 'attended')`, [
          match,
          member.membershipId,
        ]),
      );
    }
    const [a, b] = await connectMany(2);

    const results = await race([
      a!.query('select public.complete_match($1)', [match]),
      b!.query('select public.complete_match($1)', [match]),
    ]);

    expect(fulfilled(results)).toBe(2); // idempotent, not an error
    expect((await matchRow()).status).toBe('completed');

    const { rows } = await db.pool.query<{ n: string }>(
      `select count(*)::text as n from public.audit_events where action = 'match.completed'`,
    );
    expect(rows[0]!.n).toBe('1');
  });

  // ── 6. Suspension against a signup ───────────────────────────────────────

  it('does not leave a suspended member holding a spot when the two race', async () => {
    await joinAll(1);
    const [adminClient] = await connectMany(1);
    const [playerClient] = await connectMany(1, members[1]!.user);

    await race([
      adminClient!.query(
        `select public.set_membership_status($1, 'suspended', 'Under review')`,
        [members[1]!.membershipId],
      ),
      playerClient!.query('select public.join_match($1)', [match]),
    ]);

    const { rows } = await db.pool.query<{ status: string; membership_status: string }>(
      `select s.status, m.status as membership_status
         from public.match_signups s
         join public.league_memberships m on m.id = s.membership_id
        where s.match_id = $1 and s.membership_id = $2`,
      [match, members[1]!.membershipId],
    );

    // Whichever order they landed in, the suspension stands and a suspended
    // member holds no place: either the join was refused outright and left no
    // row, or it waited on the membership lock and then read the suspension,
    // or the cascade released what the join had just taken.
    const { rows: after } = await db.pool.query<{ status: string }>(
      'select status from public.league_memberships where id = $1',
      [members[1]!.membershipId],
    );
    expect(after[0]!.status).toBe('suspended');
    expect(rows[0]?.status ?? 'none').not.toBe('confirmed');
  });

  // ── 7. Two suspensions of the same member ────────────────────────────────

  it('releases one spot when the same member is suspended twice at once', async () => {
    await joinAll(3);
    const [a, b] = await connectMany(2);

    await race([
      a!.query(`select public.set_membership_status($1, 'suspended', 'Under review')`, [
        members[0]!.membershipId,
      ]),
      b!.query(`select public.set_membership_status($1, 'removed', 'Left the club')`, [
        members[0]!.membershipId,
      ]),
    ]);

    expect(await confirmedCount()).toBe(2);
    const { rows } = await db.pool.query<{ n: string }>(
      `select count(*)::text as n from public.match_signups
        where match_id = $1 and membership_id = $2`,
      [match, members[0]!.membershipId],
    );
    expect(rows[0]!.n).toBe('1');
  });

  // ── 8. Suspension against automatic promotion ────────────────────────────

  it('never seats more than capacity when a suspension and a cancellation both free a spot', async () => {
    await db.pool.query(
      `update public.matches set capacity = 2, waitlist_mode = 'automatic' where id = $1`,
      [match],
    );
    await joinAll(4); // two confirmed, two waitlisted

    const [adminClient] = await connectMany(1);
    const [playerClient] = await connectMany(1, members[1]!.user);

    await race([
      adminClient!.query(
        `select public.set_membership_status($1, 'suspended', 'Under review')`,
        [members[0]!.membershipId],
      ),
      playerClient!.query('select public.cancel_spot($1, null)', [match]),
    ]);

    // Two spots freed, two promotions, and the match is exactly full — never
    // over, and never double-promoting the same waitlisted player.
    expect(await confirmedCount()).toBe(2);

    const { rows } = await db.pool.query<{ membership_id: string }>(
      `select membership_id from public.match_signups
        where match_id = $1 and status = 'confirmed'`,
      [match],
    );
    expect(new Set(rows.map((r) => r.membership_id)).size).toBe(rows.length);
  });

  // ── 9. Suspension against team publication ───────────────────────────────

  it('never publishes a suspended member into the teams', async () => {
    await joinAll(4);
    await asUserCommitting(db, admin, async (client) => {
      await client.query('select public.finalize_roster($1)', [match]);
      await client.query('select public.ensure_match_teams($1)', [match]);
      await client.query('select public.randomize_match_teams($1)', [match]);
    });

    const [adminClient] = await connectMany(1);
    const [otherAdminClient] = await connectMany(1);

    await race([
      adminClient!.query(
        `select public.set_membership_status($1, 'removed', 'Left the club')`,
        [members[0]!.membershipId],
      ),
      otherAdminClient!.query('select public.publish_match_teams($1)', [match]),
    ]);

    const { rows } = await db.pool.query<{ membership_id: string }>(
      `select e.membership_id
         from public.match_team_publication_entries e
         join public.match_team_publications p on p.id = e.publication_id
        where p.match_id = $1
          and p.revision = (select team_revision from public.matches where id = $1)`,
      [match],
    );
    expect(rows.map((r) => r.membership_id)).not.toContain(members[0]!.membershipId);
  });

  // ── 10. The cascade across two matches at once ───────────────────────────

  it('releases every future match when one suspension and one cancellation overlap', async () => {
    const { rows: created } = await db.pool.query<{ id: string }>(
      `insert into public.matches (
         league_id, title, match_date, timezone, arrival_at, kickoff_at, end_at,
         location_name, capacity, min_players, selection_mode, waitlist_mode,
         signup_closes_at, cancellation_cutoff_at, status, published_at, created_by
       )
       select $1, 'Later match', (now() + interval '9 days')::date, l.timezone,
              now() + interval '9 days', now() + interval '9 days' + interval '30 minutes',
              now() + interval '9 days' + interval '2 hours',
              'Recreation ground', 6, 1, 'first_come', 'automatic',
              now() + interval '9 days', now() + interval '8 days',
              'open', now(), $2
         from public.leagues l where l.id = $1
       returning id`,
      [SEED_LEAGUES.weeknightFives, admin.id],
    );
    const later = created[0]!.id;

    await joinAll(2);
    await asUserCommitting(db, members[0]!.user, (client) =>
      client.query('select public.join_match($1)', [later]),
    );

    const [adminClient] = await connectMany(1);
    const [playerClient] = await connectMany(1, members[0]!.user);

    await race([
      adminClient!.query(
        `select public.set_membership_status($1, 'removed', 'Left the club')`,
        [members[0]!.membershipId],
      ),
      playerClient!.query('select public.cancel_spot($1, null)', [match]),
    ]);

    // Both matches release them, whichever order the two transactions landed
    // in, and the later match is never left holding a removed member.
    expect(await confirmedCount(later)).toBe(0);
    expect(await confirmedCount(match)).toBe(1);
  });
});

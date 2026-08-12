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
 * Phase 6 against real PostgreSQL concurrency.
 *
 * Teams add an invariant that Phase 5 can invalidate at any moment — only a
 * confirmed player may be assigned — so the dangerous races are the ones where a
 * team mutation overlaps a cancellation. Every team function takes the same
 * `select ... for update` on the match row that join, roster decisions and
 * cancellation take, and re-reads confirmation *after* acquiring it. These
 * tests are what hold that true.
 *
 * Each race uses a **separate connection per actor** fired with `Promise.all`.
 * The shared pool is not used: it caps at four connections and recycles them,
 * so two "concurrent" statements through it can serialize on one socket and
 * pass without testing anything.
 */
describe('team concurrency', () => {
  let db: TestDatabase;
  let clients: Client[] = [];
  let members: ExtraMember[];

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
    clients = [];
    await db.pool.query(
      'update public.matches set capacity = 12, min_players = 1 where id = $1',
      [SEED_MATCHES.fivesOpen],
    );
    members = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 10);
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.end()));
    await db.drop();
  });

  async function connectMany(count: number, user: SeedUser = SEED_USERS.fivesAdmin): Promise<Client[]> {
    const opened = await Promise.all(
      Array.from({ length: count }, () => connectAs(db, user)),
    );
    clients.push(...opened);
    return opened;
  }

  async function joinAll(count: number) {
    for (const member of members.slice(0, count)) {
      await asUserCommitting(db, member.user, (client) =>
        client.query('select public.join_match($1)', [SEED_MATCHES.fivesOpen]),
      );
    }
  }

  async function setUpTeams(playerCount: number, randomize = true) {
    await joinAll(playerCount);
    await asUserCommitting(db, SEED_USERS.fivesAdmin, (client) =>
      client.query('select public.ensure_match_teams($1)', [SEED_MATCHES.fivesOpen]),
    );
    if (randomize) {
      await asUserCommitting(db, SEED_USERS.fivesAdmin, (client) =>
        client.query('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]),
      );
    }
  }

  async function teamIds(): Promise<string[]> {
    const { rows } = await db.pool.query<{ id: string }>(
      'select id from public.match_teams where match_id = $1 order by display_order',
      [SEED_MATCHES.fivesOpen],
    );
    return rows.map((row) => row.id);
  }

  async function assignments(): Promise<Array<{ membership_id: string; team_id: string }>> {
    const { rows } = await db.pool.query<{ membership_id: string; team_id: string }>(
      'select membership_id, team_id from public.match_team_assignments where match_id = $1',
      [SEED_MATCHES.fivesOpen],
    );
    return rows;
  }

  async function confirmedIds(): Promise<string[]> {
    const { rows } = await db.pool.query<{ membership_id: string }>(
      `select membership_id from public.match_signups
        where match_id = $1 and status = 'confirmed'`,
      [SEED_MATCHES.fivesOpen],
    );
    return rows.map((row) => row.membership_id);
  }

  /** Settles everything, so one rejection does not hide the others' outcomes. */
  const race = <T,>(work: Array<Promise<T>>) => Promise.allSettled(work);

  it('gives one player one team when two assignments race', async () => {
    await setUpTeams(4, false);
    const teams = await teamIds();
    const [a, b] = await connectMany(2);

    await race([
      a!.query('select public.assign_player_to_team($1, $2)', [
        teams[0],
        members[0]!.membershipId,
      ]),
      b!.query('select public.assign_player_to_team($1, $2)', [
        teams[1],
        members[0]!.membershipId,
      ]),
    ]);

    const rows = await assignments();
    const mine = rows.filter((row) => row.membership_id === members[0]!.membershipId);
    // One row, whichever team won. The unique constraint makes two impossible
    // even if the lock were lost.
    expect(mine).toHaveLength(1);
  });

  it('cannot leave a canceled player assigned when assignment races cancellation', async () => {
    await setUpTeams(4, false);
    const teams = await teamIds();

    const [adminClient] = await connectMany(1);
    const [playerClient] = await connectMany(1, members[0]!.user);

    await race([
      adminClient!.query('select public.assign_player_to_team($1, $2)', [
        teams[0],
        members[0]!.membershipId,
      ]),
      playerClient!.query('select public.cancel_spot($1)', [SEED_MATCHES.fivesOpen]),
    ]);

    const { rows } = await db.pool.query<{ status: string }>(
      `select status::text from public.match_signups
        where match_id = $1 and membership_id = $2`,
      [SEED_MATCHES.fivesOpen, members[0]!.membershipId],
    );
    expect(rows[0]?.status).toBe('canceled');

    // Either the assignment ran first and the cancellation removed it, or the
    // cancellation ran first and the assignment was refused. Both orderings end
    // with no assignment for somebody who is not playing.
    const mine = (await assignments()).filter(
      (row) => row.membership_id === members[0]!.membershipId,
    );
    expect(mine).toHaveLength(0);
  });

  it('never randomizes a canceled player onto a team', async () => {
    await setUpTeams(6, false);

    const [adminClient] = await connectMany(1);
    const [playerClient] = await connectMany(1, members[0]!.user);

    await race([
      adminClient!.query('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]),
      playerClient!.query('select public.cancel_spot($1)', [SEED_MATCHES.fivesOpen]),
    ]);

    const rows = await assignments();
    const confirmed = new Set(await confirmedIds());

    // Whatever the ordering, every assignment belongs to somebody still
    // confirmed, and nobody appears twice.
    for (const row of rows) {
      expect(confirmed.has(row.membership_id)).toBe(true);
    }
    expect(new Set(rows.map((row) => row.membership_id)).size).toBe(rows.length);
  });

  it('never publishes a snapshot containing a canceled player', async () => {
    await setUpTeams(6);

    const [adminClient] = await connectMany(1);
    const [playerClient] = await connectMany(1, members[0]!.user);

    await race([
      adminClient!.query('select public.publish_match_teams($1)', [SEED_MATCHES.fivesOpen]),
      playerClient!.query('select public.cancel_spot($1)', [SEED_MATCHES.fivesOpen]),
    ]);

    const { rows: signup } = await db.pool.query<{ status: string }>(
      `select status::text from public.match_signups
        where match_id = $1 and membership_id = $2`,
      [SEED_MATCHES.fivesOpen, members[0]!.membershipId],
    );
    expect(signup[0]?.status).toBe('canceled');

    // The publication may or may not have won the lock. What must hold either
    // way: nothing a player can see includes somebody who is not playing.
    const visible = await asUserCommitting(db, members[1]!.user, async (client) => {
      const result = await client.query<{ membership_id: string }>(
        'select membership_id from public.match_published_teams($1)',
        [SEED_MATCHES.fivesOpen],
      );
      return result.rows.map((row) => row.membership_id);
    });
    expect(visible).not.toContain(members[0]!.membershipId);

    // Whichever order the two landed in, the revision counts real states: the
    // publication (if it won the lock) and the cancellation's removal are each
    // worth exactly one, and neither can happen twice.
    const { rows: revision } = await db.pool.query<{ revision: number; snapshots: string }>(
      `select m.team_revision as revision,
              (select count(*)::text from public.match_team_publications
                where match_id = m.id) as snapshots
         from public.matches m where m.id = $1`,
      [SEED_MATCHES.fivesOpen],
    );
    expect(revision[0]!.revision).toBeLessThanOrEqual(2);
    // Every revision has exactly one snapshot behind it — no gaps, no doubles.
    expect(Number(revision[0]!.snapshots)).toBe(revision[0]!.revision);

    // And one notification per recipient per revision, never two.
    const { rows: duplicates } = await db.pool.query<{ count: string }>(
      `select count(*)::text as count from (
         select idempotency_key from public.notifications
          where match_id = $1 and type in ('teams_published', 'teams_changed')
          group by idempotency_key having count(*) > 1
       ) d`,
      [SEED_MATCHES.fivesOpen],
    );
    expect(duplicates[0]?.count).toBe('0');
  });

  it('publishes once when two identical publications race', async () => {
    await setUpTeams(6);
    const admins = await connectMany(4);

    const results = await race(
      admins.map((client) =>
        client.query<{ publish_match_teams: number }>(
          'select public.publish_match_teams($1)',
          [SEED_MATCHES.fivesOpen],
        ),
      ),
    );

    // Every call answers with the same revision rather than failing: the
    // content comparison makes a duplicate publication a no-op.
    for (const result of results) {
      if (result.status === 'fulfilled') {
        expect(result.value.rows[0]?.publish_match_teams).toBe(1);
      }
    }

    const { rows } = await db.pool.query<{ revision: number; publications: string; sent: string }>(
      `select m.team_revision as revision,
              (select count(*)::text from public.match_team_publications where match_id = m.id)
                as publications,
              (select count(*)::text from public.notifications
                where match_id = m.id and type in ('teams_published','teams_changed')) as sent
         from public.matches m where m.id = $1`,
      [SEED_MATCHES.fivesOpen],
    );
    expect(rows[0]?.revision).toBe(1);
    expect(rows[0]?.publications).toBe('1');
    // One notification per confirmed player, not four rounds of them.
    expect(rows[0]?.sent).toBe('6');
  });

  it('keeps the draft coherent when a manual move races a randomize', async () => {
    await setUpTeams(8);
    const teams = await teamIds();
    const [mover, shuffler] = await connectMany(2);

    await race([
      mover!.query('select public.assign_player_to_team($1, $2)', [
        teams[0],
        members[0]!.membershipId,
      ]),
      shuffler!.query('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]),
    ]);

    const rows = await assignments();
    const confirmed = await confirmedIds();

    // Everybody confirmed is on exactly one team, and nobody is on two.
    expect(rows).toHaveLength(confirmed.length);
    expect(new Set(rows.map((row) => row.membership_id)).size).toBe(rows.length);
  });

  it('gives the last unassigned player one team when two administrators race', async () => {
    await setUpTeams(4, false);
    const teams = await teamIds();
    const admins = await connectMany(3);

    await race(
      admins.map((client, index) =>
        client.query('select public.assign_player_to_team($1, $2)', [
          teams[index % teams.length],
          members[0]!.membershipId,
        ]),
      ),
    );

    const mine = (await assignments()).filter(
      (row) => row.membership_id === members[0]!.membershipId,
    );
    expect(mine).toHaveLength(1);
  });

  it('leaves no dangling state when a delete races an assignment to that team', async () => {
    await setUpTeams(4, false);
    const teams = await teamIds();
    const [assigner, deleter] = await connectMany(2);

    await race([
      assigner!.query('select public.assign_player_to_team($1, $2)', [
        teams[1],
        members[0]!.membershipId,
      ]),
      deleter!.query('select public.delete_match_team($1)', [teams[1]]),
    ]);

    const remaining = await teamIds();
    const rows = await assignments();

    // Either the assignment landed first and the delete removed it with the
    // team, or the delete won and the assignment was refused. Neither leaves an
    // assignment pointing at a team that no longer exists.
    for (const row of rows) {
      expect(remaining).toContain(row.team_id);
    }

    // And the ordering stays contiguous.
    const { rows: orders } = await db.pool.query<{ display_order: number }>(
      'select display_order from public.match_teams where match_id = $1 order by display_order',
      [SEED_MATCHES.fivesOpen],
    );
    expect(orders.map((row) => row.display_order)).toEqual(
      orders.map((_, index) => index + 1),
    );
  });
});

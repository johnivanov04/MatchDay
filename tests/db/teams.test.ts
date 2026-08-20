import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asUser,
  asUserCommitting,
  createExtraMembers,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_LEAGUES,
  SEED_MATCHES,
  SEED_MEMBERSHIPS,
  SEED_USERS,
  type ExtraMember,
  type SeedUser,
  type TestDatabase,
} from './helpers/harness';

/**
 * Phase 6 — teams, drafts and publication.
 *
 * `fivesOpen` is the first-come match used throughout: players can seat
 * themselves, which is what makes "only a confirmed player may be assigned"
 * straightforward to set up.
 */
describe('teams', () => {
  let db: TestDatabase;
  let members: ExtraMember[];

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
    await db.pool.query(
      'update public.matches set capacity = 12, min_players = 1 where id = $1',
      [SEED_MATCHES.fivesOpen],
    );
    members = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 8);
  });

  afterEach(async () => {
    await db.drop();
  });

  const admin = SEED_USERS.fivesAdmin;

  async function join(member: ExtraMember) {
    await asUserCommitting(db, member.user, (client) =>
      client.query('select public.join_match($1)', [SEED_MATCHES.fivesOpen]),
    );
  }

  async function joinAll(count: number) {
    for (const member of members.slice(0, count)) {
      await join(member);
    }
  }

  async function callAdmin<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
    user: SeedUser = admin,
  ): Promise<T[]> {
    return asUserCommitting(db, user, async (client) => {
      const result = await client.query<T>(sql, params);
      return result.rows;
    });
  }

  async function ensureTeams() {
    return callAdmin<{ n: number }>('select public.ensure_match_teams($1) as n', [
      SEED_MATCHES.fivesOpen,
    ]);
  }

  async function teamIds(): Promise<string[]> {
    const { rows } = await db.pool.query<{ id: string }>(
      'select id from public.match_teams where match_id = $1 order by display_order',
      [SEED_MATCHES.fivesOpen],
    );
    return rows.map((row) => row.id);
  }

  async function teamSizes(): Promise<number[]> {
    const { rows } = await db.pool.query<{ size: string }>(
      `select count(a.id)::text as size
         from public.match_teams t
         left join public.match_team_assignments a on a.team_id = t.id
        where t.match_id = $1
        group by t.id, t.display_order
        order by t.display_order`,
      [SEED_MATCHES.fivesOpen],
    );
    return rows.map((row) => Number(row.size));
  }

  async function publish(user: SeedUser = admin) {
    const rows = await callAdmin<{ revision: number }>(
      'select public.publish_match_teams($1) as revision',
      [SEED_MATCHES.fivesOpen],
      user,
    );
    return rows[0]?.revision;
  }

  // ── Schema and constraints ───────────────────────────────────────────────

  describe('schema', () => {
    it('allows one team assignment per player per match', async () => {
      await joinAll(2);
      await ensureTeams();
      const teams = await teamIds();

      await db.pool.query(
        `insert into public.match_team_assignments (league_id, match_id, team_id, membership_id)
         values ($1, $2, $3, $4)`,
        [SEED_LEAGUES.weeknightFives, SEED_MATCHES.fivesOpen, teams[0], members[0]!.membershipId],
      );

      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.match_team_assignments (league_id, match_id, team_id, membership_id)
           values ($1, $2, $3, $4)`,
          [SEED_LEAGUES.weeknightFives, SEED_MATCHES.fivesOpen, teams[1], members[0]!.membershipId],
        ),
      );
      // The database, not the functions, is what makes two teams impossible.
      expect(error.code).toBe(PG_ERROR.uniqueViolation);
    });

    it('cannot assign a member of another league', async () => {
      await joinAll(1);
      await ensureTeams();
      const teams = await teamIds();

      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.match_team_assignments (league_id, match_id, team_id, membership_id)
           values ($1, $2, $3, $4)`,
          [
            SEED_LEAGUES.weeknightFives,
            SEED_MATCHES.fivesOpen,
            teams[0],
            SEED_MEMBERSHIPS.rmvfcPlayer,
          ],
        ),
      );
      expect(error.code).toBe(PG_ERROR.foreignKeyViolation);
    });

    it('cannot attach a team from one match to another match', async () => {
      await joinAll(1);
      await ensureTeams();
      const teams = await teamIds();

      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.match_team_assignments (league_id, match_id, team_id, membership_id)
           values ($1, $2, $3, $4)`,
          [
            SEED_LEAGUES.weeknightFives,
            SEED_MATCHES.rmvfcOpen,
            teams[0],
            members[0]!.membershipId,
          ],
        ),
      );
      expect(error.code).toBe(PG_ERROR.foreignKeyViolation);
    });

    it('keeps team_revision separate from roster_revision', async () => {
      await joinAll(4);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await publish();

      const { rows } = await db.pool.query<{ team: number; roster: number }>(
        'select team_revision as team, roster_revision as roster from public.matches where id = $1',
        [SEED_MATCHES.fivesOpen],
      );
      // Publishing teams says nothing about the roster.
      expect(rows[0]?.team).toBe(1);
      expect(rows[0]?.roster).toBe(0);
    });
  });

  // ── Team CRUD ────────────────────────────────────────────────────────────

  describe('creating and removing teams', () => {
    it('initialises the match’s configured number of teams, once', async () => {
      await db.pool.query('update public.matches set team_count = 3 where id = $1', [
        SEED_MATCHES.fivesOpen,
      ]);

      expect((await ensureTeams())[0]?.n).toBe(3);
      // Idempotent: opening the builder again adds nothing.
      expect((await ensureTeams())[0]?.n).toBe(3);
      expect(await teamIds()).toHaveLength(3);
    });

    it('adds, renames and labels a team', async () => {
      await ensureTeams();
      await callAdmin('select public.create_match_team($1)', [SEED_MATCHES.fivesOpen]);
      const teams = await teamIds();
      expect(teams).toHaveLength(3);

      await callAdmin('select public.rename_match_team($1, $2, $3)', [
        teams[2],
        'The Bibs',
        'Yellow',
      ]);

      const { rows } = await db.pool.query<{ name: string; label: string }>(
        'select name, label from public.match_teams where id = $1',
        [teams[2]],
      );
      expect(rows[0]).toEqual({ name: 'The Bibs', label: 'Yellow' });
    });

    it('unassigns the players of a deleted team, leaving the others alone', async () => {
      await joinAll(4);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);

      const teams = await teamIds();
      const before = await teamSizes();
      expect(before.reduce((total, size) => total + size, 0)).toBe(4);

      await callAdmin('select public.delete_match_team($1)', [teams[0]]);

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.match_team_assignments where match_id = $1`,
        [SEED_MATCHES.fivesOpen],
      );
      // Only the survivors remain — nobody was silently moved to the other team.
      expect(Number(rows[0]?.count)).toBe(before[1]);
      expect(await teamIds()).toHaveLength(1);
    });

    it('renumbers the remaining teams contiguously', async () => {
      await ensureTeams();
      await callAdmin('select public.create_match_team($1)', [SEED_MATCHES.fivesOpen]);
      const teams = await teamIds();

      await callAdmin('select public.delete_match_team($1)', [teams[0]]);

      const { rows } = await db.pool.query<{ display_order: number }>(
        'select display_order from public.match_teams where match_id = $1 order by display_order',
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows.map((row) => row.display_order)).toEqual([1, 2]);
    });

    it('refuses a player and a cross-league administrator', async () => {
      await ensureTeams();

      for (const user of [members[0]!.user, SEED_USERS.rmvfcAdmin]) {
        const error = await expectDatabaseError(() =>
          asUser(db, user, (client) =>
            client.query('select public.create_match_team($1)', [SEED_MATCHES.fivesOpen]),
          ),
        );
        expect(error.message).toContain('NOT_LEAGUE_ADMIN');
      }
    });
  });

  // ── Assignment ───────────────────────────────────────────────────────────

  describe('assigning players', () => {
    it('assigns, moves and unassigns', async () => {
      await joinAll(1);
      await ensureTeams();
      const teams = await teamIds();

      await callAdmin('select public.assign_player_to_team($1, $2)', [
        teams[0],
        members[0]!.membershipId,
      ]);
      expect(await teamSizes()).toEqual([1, 0]);

      // A move is the same call with a different team — the unique constraint
      // is what turns it into a move rather than a duplicate.
      await callAdmin('select public.assign_player_to_team($1, $2)', [
        teams[1],
        members[0]!.membershipId,
      ]);
      expect(await teamSizes()).toEqual([0, 1]);

      await callAdmin('select public.unassign_player_from_team($1, $2)', [
        SEED_MATCHES.fivesOpen,
        members[0]!.membershipId,
      ]);
      expect(await teamSizes()).toEqual([0, 0]);
    });

    it.each([
      ['waitlisted', 'waitlisted'],
      ['not_selected', 'not_selected'],
      ['interested', 'interested'],
      ['not_available', 'not_available'],
    ])('refuses a %s player', async (_label, status) => {
      await joinAll(1);
      await ensureTeams();
      const teams = await teamIds();

      // Cast once and compare as text: the same parameter cannot be deduced as
      // an enum in one place and a string in another.
      await db.pool.query(
        `update public.match_signups
            set status = $2::public.signup_status,
                waitlist_position = case when $2::text = 'waitlisted' then 1 end
          where match_id = $1 and membership_id = $3`,
        [SEED_MATCHES.fivesOpen, status, members[0]!.membershipId],
      );

      const error = await expectDatabaseError(() =>
        callAdmin('select public.assign_player_to_team($1, $2)', [
          teams[0],
          members[0]!.membershipId,
        ]),
      );
      expect(error.message).toContain('TEAM_ASSIGNMENT_INVALID');
    });

    it('refuses somebody with no signup at all', async () => {
      await joinAll(1);
      await ensureTeams();
      const teams = await teamIds();

      const error = await expectDatabaseError(() =>
        callAdmin('select public.assign_player_to_team($1, $2)', [
          teams[0],
          members[7]!.membershipId,
        ]),
      );
      expect(error.message).toContain('TEAM_ASSIGNMENT_INVALID');
    });
  });

  // ── Randomization ────────────────────────────────────────────────────────

  describe('randomize', () => {
    it.each([
      [4, 2, [2, 2]],
      [5, 2, [3, 2]],
      [7, 3, [3, 2, 2]],
      [8, 4, [2, 2, 2, 2]],
      [6, 4, [2, 2, 1, 1]],
    ])(
      'splits %i confirmed players over %i teams by count alone',
      async (playerCount, teamCount, expected) => {
        await db.pool.query('update public.matches set team_count = $2 where id = $1', [
          SEED_MATCHES.fivesOpen,
          teamCount,
        ]);
        await joinAll(playerCount);
        await ensureTeams();

        await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);

        // Sorted, because which team gets the extra player is random — the
        // invariant is the shape, never a particular arrangement.
        expect([...(await teamSizes())].sort((a, b) => b - a)).toEqual(expected);
      },
    );

    it('assigns every confirmed player exactly once, and nobody else', async () => {
      await joinAll(5);
      // One waitlisted and one who cannot play, neither of whom may appear.
      await db.pool.query(
        `update public.match_signups set status = 'not_available'
          where match_id = $1 and membership_id = $2`,
        [SEED_MATCHES.fivesOpen, members[4]!.membershipId],
      );

      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);

      const { rows } = await db.pool.query<{ membership_id: string }>(
        'select membership_id from public.match_team_assignments where match_id = $1',
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((row) => row.membership_id)).size).toBe(4);
      expect(rows.map((row) => row.membership_id)).not.toContain(members[4]!.membershipId);
    });

    it('replaces the previous layout rather than filling gaps', async () => {
      await joinAll(6);
      await ensureTeams();

      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      const first = await teamSizes();

      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      const second = await teamSizes();

      // Still valid however the shuffle landed.
      expect(first.reduce((total, size) => total + size, 0)).toBe(6);
      expect(second.reduce((total, size) => total + size, 0)).toBe(6);
      expect(Math.max(...second) - Math.min(...second)).toBeLessThanOrEqual(1);
    });

    it('reads no player attribute that could imply balance', async () => {
      // The guarantee is structural: the function body orders by random() and
      // mentions no profile column at all. Asserting on the source is the only
      // way to state "this cannot become a balancing algorithm by accident".
      const { rows } = await db.pool.query<{ src: string }>(
        `select prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'randomize_match_teams'`,
      );
      const source = rows[0]!.src;

      expect(source).toContain('order by random()');
      for (const forbidden of [
        'preferred_positions',
        'goalkeeper_willing',
        'gender',
        'priority_qualified',
        'responded_at',
        'attendance',
      ]) {
        expect(source).not.toContain(forbidden);
      }
    });

    it('refuses to randomize with fewer than two teams', async () => {
      await joinAll(2);
      await ensureTeams();
      const teams = await teamIds();
      await callAdmin('select public.delete_match_team($1)', [teams[0]]);

      const error = await expectDatabaseError(() =>
        callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]),
      );
      expect(error.message).toContain('TEAM_ASSIGNMENT_INVALID');
    });
  });

  // ── Publication ──────────────────────────────────────────────────────────

  describe('publishing', () => {
    it('refuses while a confirmed player has no team', async () => {
      await joinAll(3);
      await ensureTeams();
      const teams = await teamIds();
      await callAdmin('select public.assign_player_to_team($1, $2)', [
        teams[0],
        members[0]!.membershipId,
      ]);

      const error = await expectDatabaseError(() => publish());
      expect(error.message).toContain('TEAM_ASSIGNMENT_INVALID');
    });

    it('refuses with fewer than two teams', async () => {
      await joinAll(2);
      await ensureTeams();
      const teams = await teamIds();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await callAdmin('select public.delete_match_team($1)', [teams[0]]);

      const error = await expectDatabaseError(() => publish());
      expect(error.message).toContain('TEAM_ASSIGNMENT_INVALID');
    });

    it('publishes, notifies every confirmed player once, and audits', async () => {
      await joinAll(4);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);

      expect(await publish()).toBe(1);

      const { rows: notifications } = await db.pool.query<{ type: string; count: string }>(
        `select type::text, count(*)::text as count from public.notifications
          where match_id = $1 and type in ('teams_published', 'teams_changed') group by type`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(notifications).toEqual([{ type: 'teams_published', count: '4' }]);

      const { rows: audit } = await db.pool.query<{ after_data: Record<string, unknown> }>(
        `select after_data from public.audit_events
          where entity_id = $1 and action = 'teams.published'`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.after_data).toMatchObject({ team_revision: 1, assignment_count: 4 });
    });

    it('is idempotent when the draft has not changed', async () => {
      await joinAll(4);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);

      expect(await publish()).toBe(1);
      expect(await publish()).toBe(1);
      expect(await publish()).toBe(1);

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications
          where match_id = $1 and type in ('teams_published', 'teams_changed')`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows[0]?.count).toBe('4');
    });

    it('advances the revision and says "changed" on a genuine republication', async () => {
      await joinAll(4);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await publish();

      // A real move: swap somebody to the other team.
      const teams = await teamIds();
      const { rows: first } = await db.pool.query<{ membership_id: string; team_id: string }>(
        'select membership_id, team_id from public.match_team_assignments where match_id = $1 limit 1',
        [SEED_MATCHES.fivesOpen],
      );
      const target = first[0]!.team_id === teams[0] ? teams[1] : teams[0];
      await callAdmin('select public.assign_player_to_team($1, $2)', [
        target,
        first[0]!.membership_id,
      ]);

      expect(await publish()).toBe(2);

      const { rows } = await db.pool.query<{ type: string; count: string }>(
        `select type::text, count(*)::text as count from public.notifications
          where match_id = $1 and type in ('teams_published', 'teams_changed')
          group by type order by type`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows).toEqual([
        { type: 'teams_changed', count: '4' },
        { type: 'teams_published', count: '4' },
      ]);
    });

    it('keeps a post-publication draft edit invisible to players', async () => {
      await joinAll(4);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await publish();

      const beforeEdit = await asUser(db, members[0]!.user, async (client) => {
        const result = await client.query<{ team_name: string; membership_id: string }>(
          'select team_name, membership_id from public.match_published_teams($1)',
          [SEED_MATCHES.fivesOpen],
        );
        return result.rows;
      });

      // Move everybody to one team in the draft.
      const teams = await teamIds();
      for (const member of members.slice(0, 4)) {
        await callAdmin('select public.assign_player_to_team($1, $2)', [
          teams[0],
          member.membershipId,
        ]);
      }

      const afterEdit = await asUser(db, members[0]!.user, async (client) => {
        const result = await client.query<{ team_name: string; membership_id: string }>(
          'select team_name, membership_id from public.match_published_teams($1)',
          [SEED_MATCHES.fivesOpen],
        );
        return result.rows;
      });

      // The publication boundary is the communication boundary: players still
      // see revision 1 until the administrator republishes.
      expect(afterEdit).toEqual(beforeEdit);
    });

    it('refuses a player and a cross-league administrator', async () => {
      await joinAll(2);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);

      for (const user of [members[0]!.user, SEED_USERS.rmvfcAdmin]) {
        const error = await expectDatabaseError(() => publish(user));
        expect(error.message).toContain('NOT_LEAGUE_ADMIN');
      }
    });
  });

  // ── Cancellation integration ─────────────────────────────────────────────

  describe('cancellation after publication', () => {
    it('removes the assignment and drops the player from the published view', async () => {
      await joinAll(4);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await publish();

      await asUserCommitting(db, members[0]!.user, (client) =>
        client.query('select public.cancel_spot($1)', [SEED_MATCHES.fivesOpen]),
      );

      // The draft assignment is gone, so the builder shows the gap.
      const { rows: assignments } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.match_team_assignments
          where match_id = $1 and membership_id = $2`,
        [SEED_MATCHES.fivesOpen, members[0]!.membershipId],
      );
      expect(assignments[0]?.count).toBe('0');

      // And the remaining players no longer see them on a team, even though the
      // published snapshot still records what was announced.
      const visible = await asUser(db, members[1]!.user, async (client) => {
        const result = await client.query<{ membership_id: string }>(
          'select membership_id from public.match_published_teams($1)',
          [SEED_MATCHES.fivesOpen],
        );
        return result.rows.map((row) => row.membership_id);
      });
      expect(visible).toHaveLength(3);
      expect(visible).not.toContain(members[0]!.membershipId);
    });

    it('advances the team revision exactly once and writes a new snapshot', async () => {
      await joinAll(4);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await publish();

      await asUserCommitting(db, members[0]!.user, (client) =>
        client.query('select public.cancel_spot($1)', [SEED_MATCHES.fivesOpen]),
      );

      const { rows } = await db.pool.query<{ revision: number }>(
        'select team_revision as revision from public.matches where id = $1',
        [SEED_MATCHES.fivesOpen],
      );
      // A different player-visible state gets its own revision, so a revision
      // always identifies exactly what a player was shown.
      expect(rows[0]?.revision).toBe(2);

      const { rows: snapshots } = await db.pool.query<{ revision: number; entries: string }>(
        `select p.revision, count(e.id)::text as entries
           from public.match_team_publications p
           left join public.match_team_publication_entries e on e.publication_id = p.id
          where p.match_id = $1 group by p.revision order by p.revision`,
        [SEED_MATCHES.fivesOpen],
      );
      // The old snapshot is history and stays intact; the new one is it minus
      // the player who left.
      expect(snapshots).toEqual([
        { revision: 1, entries: '4' },
        { revision: 2, entries: '3' },
      ]);
    });

    it('tells the remaining confirmed players once, and not the one who left', async () => {
      await joinAll(4);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await publish();

      await asUserCommitting(db, members[0]!.user, (client) =>
        client.query('select public.cancel_spot($1)', [SEED_MATCHES.fivesOpen]),
      );

      const { rows } = await db.pool.query<{ recipient_user_id: string; count: string }>(
        `select recipient_user_id, count(*)::text as count from public.notifications
          where match_id = $1 and type = 'teams_changed'
          group by recipient_user_id`,
        [SEED_MATCHES.fivesOpen],
      );

      // 02 §15: "Team changes after publication create notifications." One
      // each, to the three who are still playing.
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.count === '1')).toBe(true);
      expect(rows.map((row) => row.recipient_user_id)).not.toContain(members[0]!.user.id);
    });

    it('does not advance the revision or notify again on a repeated cancellation', async () => {
      await joinAll(4);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await publish();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await asUserCommitting(db, members[0]!.user, (client) =>
          client.query('select public.cancel_spot($1)', [SEED_MATCHES.fivesOpen]),
        );
      }

      const { rows } = await db.pool.query<{ revision: number; changed: string }>(
        `select m.team_revision as revision,
                (select count(*)::text from public.notifications
                  where match_id = m.id and type = 'teams_changed') as changed
           from public.matches m where m.id = $1`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows[0]?.revision).toBe(2);
      expect(rows[0]?.changed).toBe('3');
    });

    it('changes nothing when the player was not on a published team', async () => {
      // Teams published for four; a fifth joins afterwards and then cancels.
      await joinAll(4);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await publish();

      await join(members[4]!);
      await asUserCommitting(db, members[4]!.user, (client) =>
        client.query('select public.cancel_spot($1)', [SEED_MATCHES.fivesOpen]),
      );

      const { rows } = await db.pool.query<{ revision: number; changed: string }>(
        `select m.team_revision as revision,
                (select count(*)::text from public.notifications
                  where match_id = m.id and type = 'teams_changed') as changed
           from public.matches m where m.id = $1`,
        [SEED_MATCHES.fivesOpen],
      );
      // Nothing players could see changed, so nothing is announced.
      expect(rows[0]?.revision).toBe(1);
      expect(rows[0]?.changed).toBe('0');
    });

    it('leaves an administrator-controlled replacement unassigned', async () => {
      await db.pool.query(
        `update public.matches set capacity = 4, waitlist_mode = 'admin_controlled'
          where id = $1`,
        [SEED_MATCHES.fivesOpen],
      );
      await joinAll(5);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await publish();

      await asUserCommitting(db, members[0]!.user, (client) =>
        client.query('select public.cancel_spot($1)', [SEED_MATCHES.fivesOpen]),
      );

      // Nobody is promoted at all in this mode, so nobody is assigned either.
      const { rows } = await db.pool.query<{ status: string; team_id: string | null }>(
        `select s.status::text, a.team_id
           from public.match_signups s
           left join public.match_team_assignments a
             on a.match_id = s.match_id and a.membership_id = s.membership_id
          where s.match_id = $1 and s.membership_id = $2`,
        [SEED_MATCHES.fivesOpen, members[4]!.membershipId],
      );
      expect(rows[0]?.status).toBe('waitlisted');
      expect(rows[0]?.team_id).toBeNull();

      // And once the administrator promotes them, they are still unassigned.
      await callAdmin('select public.promote_waitlisted_player($1)', [SEED_MATCHES.fivesOpen]);

      const { rows: promoted } = await db.pool.query<{ status: string; team_id: string | null }>(
        `select s.status::text, a.team_id
           from public.match_signups s
           left join public.match_team_assignments a
             on a.match_id = s.match_id and a.membership_id = s.membership_id
          where s.match_id = $1 and s.membership_id = $2`,
        [SEED_MATCHES.fivesOpen, members[4]!.membershipId],
      );
      expect(promoted[0]?.status).toBe('confirmed');
      expect(promoted[0]?.team_id).toBeNull();
    });

    it('leaves an automatically promoted replacement unassigned', async () => {
      await db.pool.query(
        `update public.matches set capacity = 4, waitlist_mode = 'automatic' where id = $1`,
        [SEED_MATCHES.fivesOpen],
      );
      await joinAll(5); // the fifth waits
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await publish();

      await asUserCommitting(db, members[0]!.user, (client) =>
        client.query('select public.cancel_spot($1)', [SEED_MATCHES.fivesOpen]),
      );

      const { rows } = await db.pool.query<{ status: string; team_id: string | null }>(
        `select s.status::text, a.team_id
           from public.match_signups s
           left join public.match_team_assignments a
             on a.match_id = s.match_id and a.membership_id = s.membership_id
          where s.match_id = $1 and s.membership_id = $2`,
        [SEED_MATCHES.fivesOpen, members[4]!.membershipId],
      );
      // Promoted, and deliberately not dropped into the vacated place: which
      // team they belong on is a decision the administrator has not made.
      expect(rows[0]?.status).toBe('confirmed');
      expect(rows[0]?.team_id).toBeNull();
    });

    it('blocks republication until the replacement is assigned', async () => {
      await db.pool.query(
        `update public.matches set capacity = 4, waitlist_mode = 'automatic' where id = $1`,
        [SEED_MATCHES.fivesOpen],
      );
      await joinAll(5);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await publish();

      await asUserCommitting(db, members[0]!.user, (client) =>
        client.query('select public.cancel_spot($1)', [SEED_MATCHES.fivesOpen]),
      );

      const error = await expectDatabaseError(() => publish());
      expect(error.message).toContain('TEAM_ASSIGNMENT_INVALID');
    });
  });

  // ── Privacy ──────────────────────────────────────────────────────────────

  describe('privacy', () => {
    it('hides draft teams and assignments from a player', async () => {
      await joinAll(4);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);

      const rows = await asUser(db, members[0]!.user, async (client) => {
        const teams = await client.query('select * from public.match_teams');
        const assignments = await client.query('select * from public.match_team_assignments');
        const published = await client.query('select * from public.match_published_teams($1)', [
          SEED_MATCHES.fivesOpen,
        ]);
        return {
          teams: teams.rows.length,
          assignments: assignments.rows.length,
          published: published.rows.length,
        };
      });

      // Nothing at all before publication — not through the tables, not
      // through the projection.
      expect(rows).toEqual({ teams: 0, assignments: 0, published: 0 });
    });

    it('hides the published snapshot tables from a player', async () => {
      await joinAll(2);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await publish();

      const rows = await asUser(db, members[0]!.user, async (client) => {
        const publications = await client.query('select * from public.match_team_publications');
        const entries = await client.query(
          'select * from public.match_team_publication_entries',
        );
        return { publications: publications.rows.length, entries: entries.rows.length };
      });
      // The projection is the only way in, so there is no second, unfiltered
      // path to the same data.
      expect(rows).toEqual({ publications: 0, entries: 0 });
    });

    it('shows published teams to a confirmed player, names only', async () => {
      await joinAll(4);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await publish();

      const fields = await asUser(db, members[0]!.user, async (client) => {
        const result = await client.query('select * from public.match_published_teams($1)', [
          SEED_MATCHES.fivesOpen,
        ]);
        return {
          columns: result.fields.map((field) => field.name).sort(),
          rows: result.rows.length,
          self: result.rows.filter((row) => (row as { is_self: boolean }).is_self).length,
        };
      });

      expect(fields.rows).toBe(4);
      expect(fields.self).toBe(1);
      // No column exists through which a position, goalkeeper flag, gender or
      // phone number could travel.
      //
      // `profile_photo_path` is the one deliberate addition (Phase 2 of profile
      // photos): an avatar travels exactly as far as the name beside it.
      // `profile_photo_url` is absent and stays absent.
      expect(fields.columns).toEqual([
        'display_order',
        'first_name',
        'is_former_member',
        'is_self',
        'last_name',
        'membership_id',
        'profile_photo_path',
        'team_label',
        'team_name',
      ]);
    });

    it('hides published teams from a waitlisted player', async () => {
      await db.pool.query('update public.matches set capacity = 2 where id = $1', [
        SEED_MATCHES.fivesOpen,
      ]);
      await joinAll(3);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await publish();

      const rows = await asUser(db, members[2]!.user, async (client) => {
        const result = await client.query('select * from public.match_published_teams($1)', [
          SEED_MATCHES.fivesOpen,
        ]);
        return result.rows;
      });
      expect(rows).toEqual([]);
    });

    it('hides published teams from somebody who has cancelled', async () => {
      await joinAll(4);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await publish();

      await asUserCommitting(db, members[0]!.user, (client) =>
        client.query('select public.cancel_spot($1)', [SEED_MATCHES.fivesOpen]),
      );

      const rows = await asUser(db, members[0]!.user, async (client) => {
        const result = await client.query('select * from public.match_published_teams($1)', [
          SEED_MATCHES.fivesOpen,
        ]);
        return result.rows;
      });
      // Having once been assigned does not keep the door open.
      expect(rows).toEqual([]);
    });

    it('hides teams from a member of another league', async () => {
      await joinAll(2);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await publish();

      const rows = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query('select * from public.match_published_teams($1)', [
          SEED_MATCHES.fivesOpen,
        ]);
        return result.rows;
      });
      expect(rows).toEqual([]);
    });

    it('keeps the builder’s indicators away from the player projection', async () => {
      await joinAll(2);
      await db.pool.query(
        `update public.leagues set gender_field_enabled = true, goalkeeper_field_enabled = true
          where id = $1`,
        [SEED_LEAGUES.weeknightFives],
      );
      await db.pool.query(
        `update public.profiles set gender = 'PRIVATE-GENDER', goalkeeper_willing = true,
                                    preferred_positions = array['Striker']
          where id = $1`,
        [members[1]!.user.id],
      );
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await publish();

      // The administrator sees the indicators…
      const builder = await asUser(db, admin, async (client) => {
        const result = await client.query<{ gender: string | null }>(
          'select gender from public.match_team_builder($1)',
          [SEED_MATCHES.fivesOpen],
        );
        return result.rows;
      });
      expect(builder.some((row) => row.gender === 'PRIVATE-GENDER')).toBe(true);

      // …and the player's team view carries none of it.
      const asPlayer = await asUser(db, members[0]!.user, async (client) => {
        const result = await client.query('select * from public.match_published_teams($1)', [
          SEED_MATCHES.fivesOpen,
        ]);
        return JSON.stringify(result.rows);
      });
      expect(asPlayer).not.toContain('PRIVATE-GENDER');
      expect(asPlayer).not.toContain('Striker');
    });

    it('refuses the builder projection to a player', async () => {
      await joinAll(2);
      await ensureTeams();

      const rows = await asUser(db, members[0]!.user, async (client) => {
        const result = await client.query('select * from public.match_team_builder($1)', [
          SEED_MATCHES.fivesOpen,
        ]);
        return result.rows;
      });
      expect(rows).toEqual([]);
    });

    it('never names a player in a team notification', async () => {
      await joinAll(3);
      await ensureTeams();
      await callAdmin('select public.randomize_match_teams($1)', [SEED_MATCHES.fivesOpen]);
      await publish();

      const { rows } = await db.pool.query<{ blob: string }>(
        `select coalesce(string_agg(title || ' ' || body, ' '), '') as blob
           from public.notifications
          where match_id = $1 and type in ('teams_published', 'teams_changed')`,
        [SEED_MATCHES.fivesOpen],
      );
      for (const member of members.slice(0, 3)) {
        expect(rows[0]?.blob).not.toContain(member.user.email);
        expect(rows[0]?.blob).not.toContain(member.membershipId);
      }
    });
  });
});

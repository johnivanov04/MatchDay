import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asUser,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_LEAGUES,
  SEED_MEMBERSHIPS,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

/**
 * The Phase 1 acceptance gate: "League A data is inaccessible from League B
 * context" (roadmap §4), and PRD §12: "A member of League A cannot infer
 * League B's membership, roster, notification, attendance, or audit data."
 *
 * Every sensitive table is swept from both administrators' points of view, and
 * the multi-league player is checked from both directions to confirm that
 * holding two memberships grants exactly two leagues' worth of access and not
 * one row more.
 */
describe('cross-league data isolation', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('seeded');
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('the RMVFC administrator', () => {
    it.each([
      ['leagues', 'select id as league_id from public.leagues'],
      ['league_memberships', 'select league_id from public.league_memberships'],
      ['audit_events', 'select league_id from public.audit_events'],
      [
        'league_membership_admin_notes',
        'select league_id from public.league_membership_admin_notes',
      ],
    ])('sees no Weeknight 5v5 rows in %s', async (_table, sql) => {
      const leagueIds = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ league_id: string }>(sql);
        return result.rows.map((row) => row.league_id);
      });

      expect(leagueIds.length).toBeGreaterThan(0);
      expect(new Set(leagueIds)).toEqual(new Set([SEED_LEAGUES.rmvfc]));
    });
  });

  describe('the Weeknight 5v5 administrator', () => {
    it.each([
      ['leagues', 'select id as league_id from public.leagues'],
      ['league_memberships', 'select league_id from public.league_memberships'],
      ['audit_events', 'select league_id from public.audit_events'],
      [
        'league_membership_admin_notes',
        'select league_id from public.league_membership_admin_notes',
      ],
    ])('sees no RMVFC rows in %s', async (_table, sql) => {
      const leagueIds = await asUser(db, SEED_USERS.fivesAdmin, async (client) => {
        const result = await client.query<{ league_id: string }>(sql);
        return result.rows.map((row) => row.league_id);
      });

      expect(leagueIds.length).toBeGreaterThan(0);
      expect(new Set(leagueIds)).toEqual(new Set([SEED_LEAGUES.weeknightFives]));
    });
  });

  describe('the player who belongs to both leagues', () => {
    it('sees exactly two leagues and two memberships', async () => {
      const counts = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
        const leagues = await client.query('select id from public.leagues');
        const memberships = await client.query('select id from public.league_memberships');
        return { leagues: leagues.rowCount, memberships: memberships.rowCount };
      });

      expect(counts).toEqual({ leagues: 2, memberships: 2 });
    });

    it('sees no administrator-only data in either league', async () => {
      const counts = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
        const notes = await client.query('select id from public.league_membership_admin_notes');
        const audit = await client.query('select id from public.audit_events');
        return { notes: notes.rowCount, audit: audit.rowCount };
      });

      expect(counts).toEqual({ notes: 0, audit: 0 });
    });

    it('cannot read the administrator note written about another member', async () => {
      const rows = await asUser(db, SEED_USERS.suspendedPlayer, async (client) => {
        const result = await client.query('select note from public.league_membership_admin_notes');
        return result.rows;
      });

      // The note in the seed is *about* this very member. Keeping notes off
      // `league_memberships` is what makes this assertion possible at all: a
      // policy cannot hide one column of a row the member is allowed to read.
      expect(rows).toEqual([]);
    });

    it('is invisible to the administrator of a league they do not belong to', async () => {
      const ids = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ id: string }>('select id from public.profiles');
        return result.rows.map((row) => row.id);
      });

      expect(ids).toContain(SEED_USERS.multiLeaguePlayer.id);
      expect(ids).not.toContain(SEED_USERS.pendingPlayer.id);
    });
  });

  describe('active-league selection is not an authorization mechanism', () => {
    it('does not widen or narrow access when the active league changes', async () => {
      // Switching leagues changes the view, never the permissions: no policy
      // anywhere consults `active_league_id`.
      const visible = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
        await client.query(
          'update public.user_app_state set active_league_id = $2 where user_id = $1',
          [SEED_USERS.multiLeaguePlayer.id, SEED_LEAGUES.weeknightFives],
        );
        const leagues = await client.query('select id from public.leagues');
        const memberships = await client.query('select id from public.league_memberships');
        return { leagues: leagues.rowCount, memberships: memberships.rowCount };
      });

      expect(visible).toEqual({ leagues: 2, memberships: 2 });
    });

    it('refuses a league the user does not actively belong to', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(
            `insert into public.user_app_state (user_id, active_league_id) values ($1, $2)`,
            [SEED_USERS.rmvfcPlayer.id, SEED_LEAGUES.weeknightFives],
          ),
        ),
      );

      expect(error.code).toBe(PG_ERROR.checkViolation);
      expect(error.message).toContain('MEMBERSHIP_REQUIRED');
    });

    it('cannot be used as an oracle for another user’s memberships', async () => {
      // A BEFORE trigger runs ahead of the RLS WITH CHECK, so a validation
      // error that distinguished "member" from "not a member" would leak
      // another tenant's membership. Both probes must fail identically.
      const inLeagueTheyBelongTo = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.outsider, (client) =>
          client.query(
            `insert into public.user_app_state (user_id, active_league_id) values ($1, $2)`,
            [SEED_USERS.multiLeaguePlayer.id, SEED_LEAGUES.rmvfc],
          ),
        ),
      );

      const inLeagueTheyDoNot = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.outsider, (client) =>
          client.query(
            `insert into public.user_app_state (user_id, active_league_id) values ($1, $2)`,
            [SEED_USERS.pendingPlayer.id, SEED_LEAGUES.rmvfc],
          ),
        ),
      );

      expect(inLeagueTheyBelongTo.code).toBe(PG_ERROR.insufficientPrivilege);
      expect(inLeagueTheyDoNot.code).toBe(PG_ERROR.insufficientPrivilege);
      expect(inLeagueTheyBelongTo.message).toBe(inLeagueTheyDoNot.message);
    });
  });

  describe('a forged identity claim buys nothing', () => {
    it('scopes access to the JWT subject, not to any value in the query', async () => {
      // `asUser` sets `request.jwt.claims` exactly as PostgREST does from a
      // verified token. Asking for another user's rows still returns nothing,
      // because every policy is written against auth.uid() rather than against
      // a predicate the caller supplies.
      const rows = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query(
          'select id from public.league_memberships where user_id = $1',
          [SEED_USERS.fivesAdmin.id],
        );
        return result.rows;
      });

      expect(rows).toEqual([]);
    });

    it('does not let a member of one league read another league by guessing its id', async () => {
      const rows = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query('select id from public.leagues where id = $1', [
          SEED_LEAGUES.weeknightFives,
        ]);
        return result.rows;
      });

      expect(rows).toEqual([]);
    });

    it('does not let a member read another league’s membership by guessing its id', async () => {
      const rows = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query(
          'select id from public.league_memberships where id = $1',
          [SEED_MEMBERSHIPS.fivesPending],
        );
        return result.rows;
      });

      expect(rows).toEqual([]);
    });
  });
});

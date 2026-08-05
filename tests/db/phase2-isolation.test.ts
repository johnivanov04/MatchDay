import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_INVITES,
  SEED_JOIN_REQUESTS,
  SEED_LEAGUES,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

/**
 * Cross-league isolation for the tables Phase 2 adds.
 *
 * The Phase 1 gate — "League A data is inaccessible from League B context" —
 * now has to hold for join requests and invitations as well. Each table is
 * swept from both administrators' points of view, and every Phase 2 operation
 * is attempted across the tenant boundary.
 */
describe('Phase 2 cross-league isolation', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('seeded');
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('reads stay inside the tenant', () => {
    it('shows the 5v5 administrator only their own join requests', async () => {
      const leagueIds = await asUser(db, SEED_USERS.fivesAdmin, async (client) => {
        const result = await client.query<{ league_id: string }>(
          'select league_id from public.league_join_requests',
        );
        return result.rows.map((row) => row.league_id);
      });

      expect(leagueIds.length).toBeGreaterThan(0);
      expect(new Set(leagueIds)).toEqual(new Set([SEED_LEAGUES.weeknightFives]));
    });

    it('shows the RMVFC administrator only their own invitations', async () => {
      const leagueIds = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ league_id: string }>(
          'select league_id from public.league_invites',
        );
        return result.rows.map((row) => row.league_id);
      });

      expect(leagueIds.length).toBeGreaterThan(0);
      expect(new Set(leagueIds)).toEqual(new Set([SEED_LEAGUES.rmvfc]));
    });

    it('returns nothing when an administrator names another league’s row directly', async () => {
      const request = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query('select id from public.league_join_requests where id = $1', [
          SEED_JOIN_REQUESTS.outsiderToFives,
        ]);
        return result.rows;
      });

      const invite = await asUser(db, SEED_USERS.fivesAdmin, async (client) => {
        const result = await client.query('select id from public.league_invites where id = $1', [
          SEED_INVITES.rmvfc,
        ]);
        return result.rows;
      });

      expect(request).toEqual([]);
      expect(invite).toEqual([]);
    });

    it('shows the multi-league player no requests or invitations at all', async () => {
      const counts = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
        const requests = await client.query('select id from public.league_join_requests');
        const invites = await client.query('select id from public.league_invites');
        return { requests: requests.rowCount, invites: invites.rowCount };
      });

      // Active in both leagues, and still not an administrator in either.
      expect(counts).toEqual({ requests: 0, invites: 0 });
    });

    it('gives an anonymous visitor nothing', async () => {
      for (const sql of [
        'select id from public.league_join_requests',
        'select id from public.league_invites',
      ]) {
        const error = await expectDatabaseError(() => asAnon(db, (client) => client.query(sql)));
        expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
      }
    });
  });

  describe('operations refuse to cross the boundary', () => {
    // Each case names its actor explicitly: an administrator with full
    // authority in their own league, reaching into the one next door.
    it.each([
      [
        'deciding another league’s join request',
        SEED_USERS.rmvfcAdmin,
        `select public.decide_join_request('${SEED_JOIN_REQUESTS.outsiderToFives}', true)`,
      ],
      [
        'creating an invite for another league',
        SEED_USERS.rmvfcAdmin,
        `select public.create_league_invite('${SEED_LEAGUES.weeknightFives}', '${'q'.repeat(43)}')`,
      ],
      [
        'revoking another league’s invite',
        SEED_USERS.fivesAdmin,
        `select public.revoke_league_invite('${SEED_INVITES.rmvfc}')`,
      ],
      [
        'adding a member to another league',
        SEED_USERS.rmvfcAdmin,
        `select public.add_league_member_by_email('${SEED_LEAGUES.weeknightFives}', '${SEED_USERS.outsider.email}')`,
      ],
      [
        'transferring another league’s administration',
        SEED_USERS.rmvfcAdmin,
        `select public.transfer_league_administration('${SEED_LEAGUES.weeknightFives}', '33333333-3333-4333-8333-000000000012')`,
      ],
    ])('refuses %s', async (_label, actor, sql) => {
      const error = await expectDatabaseError(() =>
        asUser(db, actor, (client) => client.query(sql)),
      );

      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
    });
  });

  describe('membership does not leak between tenants', () => {
    it('keeps a 5v5-only member invisible to the RMVFC administrator', async () => {
      const ids = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ id: string }>('select id from public.profiles');
        return result.rows.map((row) => row.id);
      });

      expect(ids).not.toContain(SEED_USERS.pendingPlayer.id);
      expect(ids).not.toContain(SEED_USERS.fivesAdmin.id);
    });

    it('does not reveal a private league through its invitation table', async () => {
      // Even knowing an invite id, a non-administrator learns nothing.
      const rows = await asUser(db, SEED_USERS.outsider, async (client) => {
        const result = await client.query(
          'select id, league_id from public.league_invites where id = $1',
          [SEED_INVITES.rmvfc],
        );
        return result.rows;
      });
      expect(rows).toEqual([]);
    });
  });
});

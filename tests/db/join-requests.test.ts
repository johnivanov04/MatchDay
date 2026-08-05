import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  asUserCommitting,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_JOIN_REQUESTS,
  SEED_LEAGUES,
  SEED_MEMBERSHIPS,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

describe('join requests', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  describe('submitting', () => {
    it('creates a pending request for a searchable league', async () => {
      const status = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const created = await client.query<{ request_to_join_league: string }>(
          'select public.request_to_join_league($1, $2) as request_to_join_league',
          [SEED_LEAGUES.weeknightFives, 'Would like to play.'],
        );
        const result = await client.query<{ status: string }>(
          'select status from public.league_join_requests where id = $1',
          [created.rows[0]?.request_to_join_league],
        );
        return result.rows[0]?.status;
      });

      expect(status).toBe('pending');
    });

    it('is idempotent: asking twice returns the same request', async () => {
      const [first, second] = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const a = await client.query<{ id: string }>(
          'select public.request_to_join_league($1) as id',
          [SEED_LEAGUES.weeknightFives],
        );
        const b = await client.query<{ id: string }>(
          'select public.request_to_join_league($1) as id',
          [SEED_LEAGUES.weeknightFives],
        );
        const count = await client.query<{ count: string }>(
          `select count(*)::text as count from public.league_join_requests
            where league_id = $1 and user_id = $2`,
          [SEED_LEAGUES.weeknightFives, SEED_USERS.rmvfcPlayer.id],
        );
        expect(count.rows[0]?.count).toBe('1');
        return [a.rows[0]?.id, b.rows[0]?.id];
      });

      expect(first).toBe(second);
    });

    it('refuses a private league, using the same error as a league that does not exist', async () => {
      const privateLeague = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.outsider, (client) =>
          client.query('select public.request_to_join_league($1)', [SEED_LEAGUES.rmvfc]),
        ),
      );

      const missingLeague = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.outsider, (client) =>
          client.query('select public.request_to_join_league($1)', [
            '22222222-2222-4222-8222-0000000000ff',
          ]),
        ),
      );

      // Identical, so this cannot be used to discover that a private league exists.
      expect(privateLeague.message).toContain('LEAGUE_NOT_FOUND');
      expect(privateLeague.message).toBe(missingLeague.message);
    });

    it('refuses someone who already belongs to the league', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.multiLeaguePlayer, (client) =>
          client.query('select public.request_to_join_league($1)', [SEED_LEAGUES.weeknightFives]),
        ),
      );
      expect(error.message).toContain('MEMBERSHIP_EXISTS');
    });

    it('refuses an unauthenticated caller', async () => {
      const error = await expectDatabaseError(() =>
        asAnon(db, (client) =>
          client.query('select public.request_to_join_league($1)', [SEED_LEAGUES.weeknightFives]),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('prevents a second pending row even by direct insert', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.league_join_requests (league_id, user_id, status)
           values ($1, $2, 'pending')`,
          [SEED_LEAGUES.weeknightFives, SEED_USERS.outsider.id],
        ),
      );

      expect(error.code).toBe(PG_ERROR.uniqueViolation);
      expect(error.message).toContain('league_join_requests_one_pending_key');
    });

    it('allows a fresh request after an earlier one was rejected', async () => {
      await db.pool.query(
        `update public.league_join_requests
            set status = 'rejected', decided_at = now() where id = $1`,
        [SEED_JOIN_REQUESTS.outsiderToFives],
      );

      const status = await asUser(db, SEED_USERS.outsider, async (client) => {
        const created = await client.query<{ id: string }>(
          'select public.request_to_join_league($1) as id',
          [SEED_LEAGUES.weeknightFives],
        );
        const result = await client.query<{ status: string }>(
          'select status from public.league_join_requests where id = $1',
          [created.rows[0]?.id],
        );
        return result.rows[0]?.status;
      });

      expect(status).toBe('pending');
    });
  });

  describe('visibility', () => {
    it('shows an administrator the requests for their own league', async () => {
      const rows = await asUser(db, SEED_USERS.fivesAdmin, async (client) => {
        const result = await client.query<{ id: string }>(
          'select id from public.league_join_requests',
        );
        return result.rows;
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(SEED_JOIN_REQUESTS.outsiderToFives);
    });

    it('hides them from another league’s administrator', async () => {
      const rows = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query('select id from public.league_join_requests');
        return result.rows;
      });
      expect(rows).toEqual([]);
    });

    it('hides them from ordinary members of the same league', async () => {
      const rows = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
        const result = await client.query('select id from public.league_join_requests');
        return result.rows;
      });
      expect(rows).toEqual([]);
    });

    it('shows requesters their own request', async () => {
      const rows = await asUser(db, SEED_USERS.outsider, async (client) => {
        const result = await client.query<{ id: string }>(
          'select id from public.league_join_requests',
        );
        return result.rows;
      });
      expect(rows).toHaveLength(1);
    });

    it('gives no client a write path to the table', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.fivesAdmin, (client) =>
          client.query(`update public.league_join_requests set status = 'approved'`),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });

  describe('approval', () => {
    it('creates exactly one active membership', async () => {
      await asUserCommitting(db, SEED_USERS.fivesAdmin, (client) =>
        client.query('select public.decide_join_request($1, true)', [
          SEED_JOIN_REQUESTS.outsiderToFives,
        ]),
      );

      const { rows } = await db.pool.query<{ status: string; role: string }>(
        'select status, role from public.league_memberships where league_id = $1 and user_id = $2',
        [SEED_LEAGUES.weeknightFives, SEED_USERS.outsider.id],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'active', role: 'player' });
    });

    it('is idempotent: approving twice still yields one membership', async () => {
      await asUserCommitting(db, SEED_USERS.fivesAdmin, (client) =>
        client.query('select public.decide_join_request($1, true)', [
          SEED_JOIN_REQUESTS.outsiderToFives,
        ]),
      );
      await asUserCommitting(db, SEED_USERS.fivesAdmin, (client) =>
        client.query('select public.decide_join_request($1, true)', [
          SEED_JOIN_REQUESTS.outsiderToFives,
        ]),
      );

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.league_memberships
          where league_id = $1 and user_id = $2`,
        [SEED_LEAGUES.weeknightFives, SEED_USERS.outsider.id],
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('reactivates a previously removed member instead of adding a second row', async () => {
      // Remove the RMVFC player, make RMVFC searchable, then have them re-apply.
      await db.pool.query(
        `update public.league_memberships set status = 'removed' where id = $1`,
        [SEED_MEMBERSHIPS.rmvfcPlayer],
      );
      await db.pool.query(`update public.leagues set visibility = 'searchable' where id = $1`, [
        SEED_LEAGUES.rmvfc,
      ]);

      const requestId = await asUserCommitting(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const created = await client.query<{ id: string }>(
          'select public.request_to_join_league($1) as id',
          [SEED_LEAGUES.rmvfc],
        );
        return created.rows[0]?.id ?? '';
      });

      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.decide_join_request($1, true)', [requestId]),
      );

      const { rows } = await db.pool.query<{ id: string; status: string }>(
        'select id, status from public.league_memberships where league_id = $1 and user_id = $2',
        [SEED_LEAGUES.rmvfc, SEED_USERS.rmvfcPlayer.id],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(SEED_MEMBERSHIPS.rmvfcPlayer);
      expect(rows[0]?.status).toBe('active');
    });

    it('records join_request.approved', async () => {
      await asUserCommitting(db, SEED_USERS.fivesAdmin, (client) =>
        client.query('select public.decide_join_request($1, true, $2)', [
          SEED_JOIN_REQUESTS.outsiderToFives,
          'Welcome aboard',
        ]),
      );

      const { rows } = await db.pool.query<{ action: string; reason: string }>(
        `select action, reason from public.audit_events
          where entity_id = $1 and action = 'join_request.approved'`,
        [SEED_JOIN_REQUESTS.outsiderToFives],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.reason).toBe('Welcome aboard');
    });
  });

  describe('rejection', () => {
    it('creates no membership', async () => {
      await asUserCommitting(db, SEED_USERS.fivesAdmin, (client) =>
        client.query('select public.decide_join_request($1, false, $2)', [
          SEED_JOIN_REQUESTS.outsiderToFives,
          'Full for now',
        ]),
      );

      const { rows } = await db.pool.query(
        'select id from public.league_memberships where league_id = $1 and user_id = $2',
        [SEED_LEAGUES.weeknightFives, SEED_USERS.outsider.id],
      );
      expect(rows).toEqual([]);
    });

    it('leaves the rejected user without access to member-only data', async () => {
      await asUserCommitting(db, SEED_USERS.fivesAdmin, (client) =>
        client.query('select public.decide_join_request($1, false)', [
          SEED_JOIN_REQUESTS.outsiderToFives,
        ]),
      );

      const visible = await asUser(db, SEED_USERS.outsider, async (client) => {
        const leagues = await client.query('select id from public.leagues');
        const memberships = await client.query('select id from public.league_memberships');
        return { leagues: leagues.rowCount, memberships: memberships.rowCount };
      });

      expect(visible).toEqual({ leagues: 0, memberships: 0 });
    });
  });

  describe('authorization', () => {
    it('refuses a player', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.multiLeaguePlayer, (client) =>
          client.query('select public.decide_join_request($1, true)', [
            SEED_JOIN_REQUESTS.outsiderToFives,
          ]),
        ),
      );
      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
    });

    it('refuses another league’s administrator', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query('select public.decide_join_request($1, true)', [
            SEED_JOIN_REQUESTS.outsiderToFives,
          ]),
        ),
      );
      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
    });

    it('reports an unknown request exactly as an unauthorised one', async () => {
      const unknown = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query('select public.decide_join_request($1, true)', [
            '66666666-6666-4666-8666-0000000000ff',
          ]),
        ),
      );
      expect(unknown.message).toContain('NOT_LEAGUE_ADMIN');
    });
  });

  describe('withdrawal', () => {
    it('lets the requester withdraw their own request', async () => {
      await asUserCommitting(db, SEED_USERS.outsider, (client) =>
        client.query('select public.withdraw_join_request($1)', [
          SEED_JOIN_REQUESTS.outsiderToFives,
        ]),
      );

      const { rows } = await db.pool.query<{ status: string }>(
        'select status from public.league_join_requests where id = $1',
        [SEED_JOIN_REQUESTS.outsiderToFives],
      );
      expect(rows[0]?.status).toBe('withdrawn');
    });

    it('refuses to withdraw someone else’s request', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('select public.withdraw_join_request($1)', [
            SEED_JOIN_REQUESTS.outsiderToFives,
          ]),
        ),
      );
      expect(error.message).toContain('NOT_AUTHORIZED');
    });

    it('is idempotent once decided', async () => {
      await asUserCommitting(db, SEED_USERS.fivesAdmin, (client) =>
        client.query('select public.decide_join_request($1, true)', [
          SEED_JOIN_REQUESTS.outsiderToFives,
        ]),
      );
      await asUserCommitting(db, SEED_USERS.outsider, (client) =>
        client.query('select public.withdraw_join_request($1)', [
          SEED_JOIN_REQUESTS.outsiderToFives,
        ]),
      );

      const { rows } = await db.pool.query<{ status: string }>(
        'select status from public.league_join_requests where id = $1',
        [SEED_JOIN_REQUESTS.outsiderToFives],
      );
      // The approval stands; a withdrawal cannot undo a decision.
      expect(rows[0]?.status).toBe('approved');
    });
  });
});

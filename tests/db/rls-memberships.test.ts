import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_LEAGUES,
  SEED_MEMBERSHIPS,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

describe('RLS — league memberships', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('seeded');
  });

  afterAll(async () => {
    await db.drop();
  });

  it('shows a player only their own memberships', async () => {
    const rows = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
      const result = await client.query<{ id: string; user_id: string }>(
        'select id, user_id from public.league_memberships',
      );
      return result.rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(SEED_MEMBERSHIPS.rmvfcPlayer);
  });

  it('shows the multi-league player both memberships and nothing else', async () => {
    const rows = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
      const result = await client.query<{ id: string; league_id: string }>(
        'select id, league_id from public.league_memberships',
      );
      return result.rows;
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.league_id).sort()).toEqual(
      [SEED_LEAGUES.rmvfc, SEED_LEAGUES.weeknightFives].sort(),
    );
  });

  it('shows a league administrator every membership in their league', async () => {
    const rows = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
      const result = await client.query<{ id: string; league_id: string; status: string }>(
        'select id, league_id, status from public.league_memberships',
      );
      return result.rows;
    });

    // Five RMVFC memberships in the seed: admin, two active players, one
    // suspended, one removed. All are the administrator's business.
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.league_id))).toEqual(new Set([SEED_LEAGUES.rmvfc]));
    expect(new Set(rows.map((row) => row.status))).toEqual(
      new Set(['active', 'suspended', 'removed']),
    );
  });

  it('hides another league’s memberships from a league administrator', async () => {
    const leagueIds = await asUser(db, SEED_USERS.fivesAdmin, async (client) => {
      const result = await client.query<{ league_id: string }>(
        'select league_id from public.league_memberships',
      );
      return result.rows.map((row) => row.league_id);
    });

    expect(new Set(leagueIds)).toEqual(new Set([SEED_LEAGUES.weeknightFives]));
  });

  it('shows a removed member only their own removed membership', async () => {
    const rows = await asUser(db, SEED_USERS.removedPlayer, async (client) => {
      const result = await client.query<{ id: string; status: string }>(
        'select id, status from public.league_memberships',
      );
      return result.rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('removed');
  });

  it('lets a league administrator change a member’s status', async () => {
    const rows = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
      const result = await client.query<{ status: string; suspended_until: Date | null }>(
        `update public.league_memberships
            set status = 'suspended', suspended_until = now() + interval '7 days'
          where id = $1
          returning status, suspended_until`,
        [SEED_MEMBERSHIPS.rmvfcPlayer],
      );
      return result.rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('suspended');
    expect(rows[0]?.suspended_until).not.toBeNull();
  });

  it('does not let a player change their own membership status', async () => {
    const rowCount = await asUser(db, SEED_USERS.pendingPlayer, async (client) => {
      const result = await client.query(
        `update public.league_memberships set status = 'active' where id = $1`,
        [SEED_MEMBERSHIPS.fivesPending],
      );
      return result.rowCount;
    });

    expect(rowCount).toBe(0);

    const { rows } = await db.pool.query<{ status: string }>(
      'select status from public.league_memberships where id = $1',
      [SEED_MEMBERSHIPS.fivesPending],
    );
    expect(rows[0]?.status).toBe('pending');
  });

  it('does not let a player promote themselves to administrator', async () => {
    const rowCount = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
      const result = await client.query(
        `update public.league_memberships set role = 'league_admin' where id = $1`,
        [SEED_MEMBERSHIPS.rmvfcPlayer],
      );
      return result.rowCount;
    });

    expect(rowCount).toBe(0);
  });

  it('does not let one league’s administrator touch another league’s membership', async () => {
    const rowCount = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
      const result = await client.query(
        `update public.league_memberships set status = 'removed' where id = $1`,
        [SEED_MEMBERSHIPS.fivesPending],
      );
      return result.rowCount;
    });

    expect(rowCount).toBe(0);
  });

  it('rejects joining a league by inserting a membership directly', async () => {
    // Invitations and join requests are Phase 2. Until then no client-side
    // INSERT path exists at all, which is stronger than a policy that merely
    // restricts one.
    const error = await expectDatabaseError(() =>
      asUser(db, SEED_USERS.outsider, (client) =>
        client.query(
          `insert into public.league_memberships (league_id, user_id, role, status)
           values ($1, $2, 'player', 'active')`,
          [SEED_LEAGUES.weeknightFives, SEED_USERS.outsider.id],
        ),
      ),
    );

    expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
  });

  it('rejects deleting a membership, so history cannot be erased', async () => {
    const error = await expectDatabaseError(() =>
      asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('delete from public.league_memberships where id = $1', [
          SEED_MEMBERSHIPS.rmvfcPlayer,
        ]),
      ),
    );

    expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
  });

  it('refuses to move a membership to another league, even for an administrator', async () => {
    const error = await expectDatabaseError(() =>
      asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('update public.league_memberships set league_id = $1 where id = $2', [
          SEED_LEAGUES.weeknightFives,
          SEED_MEMBERSHIPS.rmvfcPlayer,
        ]),
      ),
    );

    expect(error.code).toBe(PG_ERROR.checkViolation);
    expect(error.message).toContain('MEMBERSHIP_LEAGUE_IMMUTABLE');
  });

  it('refuses to re-point a membership at a different person', async () => {
    // Without this guard, an administrator holding UPDATE rights could rewrite
    // `user_id` and hand someone else's account a membership.
    const error = await expectDatabaseError(() =>
      asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('update public.league_memberships set user_id = $1 where id = $2', [
          SEED_USERS.outsider.id,
          SEED_MEMBERSHIPS.rmvfcPlayer,
        ]),
      ),
    );

    expect(error.code).toBe(PG_ERROR.checkViolation);
    expect(error.message).toContain('MEMBERSHIP_USER_IMMUTABLE');
  });

  it('gives an unauthenticated visitor no access to memberships', async () => {
    const error = await expectDatabaseError(() =>
      asAnon(db, (client) => client.query('select id from public.league_memberships')),
    );

    expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
  });
});

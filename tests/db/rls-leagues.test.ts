import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_LEAGUES,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

describe('RLS — leagues', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('seeded');
  });

  afterAll(async () => {
    await db.drop();
  });

  async function visibleLeagueIds(user: (typeof SEED_USERS)[keyof typeof SEED_USERS]) {
    return asUser(db, user, async (client) => {
      const result = await client.query<{ id: string }>('select id from public.leagues order by name');
      return result.rows.map((row) => row.id);
    });
  }

  it('shows a member only their own league', async () => {
    expect(await visibleLeagueIds(SEED_USERS.rmvfcPlayer)).toEqual([SEED_LEAGUES.rmvfc]);
  });

  it('shows the multi-league player both of their leagues', async () => {
    const ids = await visibleLeagueIds(SEED_USERS.multiLeaguePlayer);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(SEED_LEAGUES.rmvfc);
    expect(ids).toContain(SEED_LEAGUES.weeknightFives);
  });

  it('shows a pending member the league they are waiting on', async () => {
    expect(await visibleLeagueIds(SEED_USERS.pendingPlayer)).toEqual([SEED_LEAGUES.weeknightFives]);
  });

  it('shows a suspended member the league they are suspended from', async () => {
    expect(await visibleLeagueIds(SEED_USERS.suspendedPlayer)).toEqual([SEED_LEAGUES.rmvfc]);
  });

  it('shows a removed member nothing', async () => {
    expect(await visibleLeagueIds(SEED_USERS.removedPlayer)).toEqual([]);
  });

  it('hides even the searchable league from a signed-in non-member', async () => {
    // Public discovery is Phase 2 and will use a restricted projection view.
    // Until then, `leagues` rows are member-only — including the searchable
    // one, whose full row holds settings and location details that the public
    // projection must never carry (PRD §12).
    expect(await visibleLeagueIds(SEED_USERS.outsider)).toEqual([]);
  });

  it('gives an unauthenticated visitor no access to leagues', async () => {
    const error = await expectDatabaseError(() =>
      asAnon(db, (client) => client.query('select id from public.leagues')),
    );
    expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
  });

  it('lets the league administrator edit their own league settings', async () => {
    const rows = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
      const result = await client.query<{ visibility: string; default_capacity: number }>(
        `update public.leagues
            set visibility = 'searchable', default_capacity = 20
          where id = $1
          returning visibility, default_capacity`,
        [SEED_LEAGUES.rmvfc],
      );
      return result.rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.visibility).toBe('searchable');
    expect(rows[0]?.default_capacity).toBe(20);
  });

  it('does not let a player edit their league', async () => {
    const rowCount = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
      const result = await client.query(
        `update public.leagues set visibility = 'searchable' where id = $1`,
        [SEED_LEAGUES.rmvfc],
      );
      return result.rowCount;
    });

    expect(rowCount).toBe(0);
  });

  it('does not let a suspended member edit their league', async () => {
    const rowCount = await asUser(db, SEED_USERS.suspendedPlayer, async (client) => {
      const result = await client.query(`update public.leagues set name = 'Renamed' where id = $1`, [
        SEED_LEAGUES.rmvfc,
      ]);
      return result.rowCount;
    });

    expect(rowCount).toBe(0);
  });

  it('does not let one league’s administrator edit another league', async () => {
    const rowCount = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
      const result = await client.query(
        `update public.leagues set default_capacity = 99 where id = $1`,
        [SEED_LEAGUES.weeknightFives],
      );
      return result.rowCount;
    });

    expect(rowCount).toBe(0);

    const { rows } = await db.pool.query<{ default_capacity: number }>(
      'select default_capacity from public.leagues where id = $1',
      [SEED_LEAGUES.weeknightFives],
    );
    expect(rows[0]?.default_capacity).toBe(10);
  });

  it('gives no client the ability to create a league in Phase 1', async () => {
    const error = await expectDatabaseError(() =>
      asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(
          `insert into public.leagues
             (name, slug, general_area, timezone, sport_label, description, default_capacity)
           values ('Shadow League', 'shadow-league', 'Elsewhere', 'UTC',
                   'Soccer 7v7', 'Created without server authorization.', 14)`,
        ),
      ),
    );

    expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
  });

  it('gives no client the ability to delete a league', async () => {
    const error = await expectDatabaseError(() =>
      asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('delete from public.leagues where id = $1', [SEED_LEAGUES.rmvfc]),
      ),
    );

    expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asUser,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_LEAGUES,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

describe('active-league selection (user_app_state)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('seeded');
  });

  afterAll(async () => {
    await db.drop();
  });

  it('shows a user only their own row', async () => {
    const rows = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
      const result = await client.query<{ user_id: string; active_league_id: string }>(
        'select user_id, active_league_id from public.user_app_state',
      );
      return result.rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(SEED_USERS.multiLeaguePlayer.id);
    expect(rows[0]?.active_league_id).toBe(SEED_LEAGUES.rmvfc);
  });

  it('lets a user switch to another league they actively belong to', async () => {
    const active = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
      const result = await client.query<{ active_league_id: string }>(
        `update public.user_app_state
            set active_league_id = $2
          where user_id = $1
          returning active_league_id`,
        [SEED_USERS.multiLeaguePlayer.id, SEED_LEAGUES.weeknightFives],
      );
      return result.rows[0]?.active_league_id;
    });

    expect(active).toBe(SEED_LEAGUES.weeknightFives);
  });

  it('refuses a league the user has no active membership in', async () => {
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

  it('refuses a league where the membership is only pending', async () => {
    const error = await expectDatabaseError(() =>
      asUser(db, SEED_USERS.pendingPlayer, (client) =>
        client.query(
          `insert into public.user_app_state (user_id, active_league_id) values ($1, $2)`,
          [SEED_USERS.pendingPlayer.id, SEED_LEAGUES.weeknightFives],
        ),
      ),
    );

    expect(error.message).toContain('MEMBERSHIP_REQUIRED');
  });

  it('refuses a league where the membership is suspended', async () => {
    const error = await expectDatabaseError(() =>
      asUser(db, SEED_USERS.suspendedPlayer, (client) =>
        client.query(
          `insert into public.user_app_state (user_id, active_league_id) values ($1, $2)`,
          [SEED_USERS.suspendedPlayer.id, SEED_LEAGUES.rmvfc],
        ),
      ),
    );

    expect(error.message).toContain('MEMBERSHIP_REQUIRED');
  });

  it('allows clearing the active league', async () => {
    const active = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
      const result = await client.query<{ active_league_id: string | null }>(
        `update public.user_app_state set active_league_id = null
          where user_id = $1 returning active_league_id`,
        [SEED_USERS.multiLeaguePlayer.id],
      );
      return result.rows[0]?.active_league_id;
    });

    expect(active).toBeNull();
  });

  it('refuses to write state on behalf of another user', async () => {
    const error = await expectDatabaseError(() =>
      asUser(db, SEED_USERS.outsider, (client) =>
        client.query(
          `insert into public.user_app_state (user_id, active_league_id) values ($1, $2)`,
          [SEED_USERS.multiLeaguePlayer.id, SEED_LEAGUES.rmvfc],
        ),
      ),
    );

    expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
  });

  it('refuses to overwrite another user’s selection', async () => {
    const rowCount = await asUser(db, SEED_USERS.outsider, async (client) => {
      const result = await client.query(
        'update public.user_app_state set active_league_id = null where user_id = $1',
        [SEED_USERS.multiLeaguePlayer.id],
      );
      return result.rowCount;
    });

    expect(rowCount).toBe(0);
  });

  it('refuses to delete another user’s selection', async () => {
    const rowCount = await asUser(db, SEED_USERS.outsider, async (client) => {
      const result = await client.query('delete from public.user_app_state where user_id = $1', [
        SEED_USERS.multiLeaguePlayer.id,
      ]);
      return result.rowCount;
    });

    expect(rowCount).toBe(0);
  });
});

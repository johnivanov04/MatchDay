import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_LEAGUES,
  SEED_MEMBERSHIPS,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

/**
 * "A league cannot have zero or two active administrators after a successful
 * transaction." — 02 §6 (F-02) acceptance criteria.
 *
 * Two database mechanisms together deliver that, and both are exercised here:
 *   * `league_memberships_single_active_admin_key`, a partial unique index,
 *     forbids a second active administrator, immediately;
 *   * `enforce_single_active_league_admin`, a DEFERRABLE INITIALLY DEFERRED
 *     constraint trigger, forbids zero, at COMMIT.
 *
 * These run as the superuser, i.e. with RLS bypassed. That is deliberate: the
 * point is that the rule holds even for the most privileged connection in the
 * system, not merely for the application's own code paths.
 *
 * Several cases here genuinely commit, so each test gets its own cloned
 * database rather than sharing one.
 */
describe('exactly one active league administrator per league', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  it('rejects promoting a second active administrator in the same league', async () => {
    const error = await expectDatabaseError(() =>
      db.pool.query(`update public.league_memberships set role = 'league_admin' where id = $1`, [
        SEED_MEMBERSHIPS.rmvfcPlayer,
      ]),
    );

    expect(error.code).toBe(PG_ERROR.uniqueViolation);
    expect(error.message).toContain('league_memberships_single_active_admin_key');
  });

  it('rejects inserting a second active administrator', async () => {
    const error = await expectDatabaseError(() =>
      db.pool.query(
        `insert into public.league_memberships (league_id, user_id, role, status)
         values ($1, $2, 'league_admin', 'active')`,
        [SEED_LEAGUES.rmvfc, SEED_USERS.outsider.id],
      ),
    );

    expect(error.code).toBe(PG_ERROR.uniqueViolation);
  });

  it('allows a former administrator to remain on record once removed', async () => {
    // The partial index covers only *active* administrators, so history is
    // preserved rather than deleted (02 §19).
    await db.pool.query(
      `insert into public.league_memberships (league_id, user_id, role, status)
       values ($1, $2, 'league_admin', 'removed')`,
      [SEED_LEAGUES.rmvfc, SEED_USERS.outsider.id],
    );

    const { rows } = await db.pool.query<{ count: string }>(
      `select count(*)::text as count
         from public.league_memberships
        where league_id = $1 and role = 'league_admin'`,
      [SEED_LEAGUES.rmvfc],
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });

  it('rejects removing the only active administrator, at COMMIT', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('begin');
      // The statement itself succeeds — the deferred trigger has not run yet.
      await client.query(`update public.league_memberships set status = 'removed' where id = $1`, [
        SEED_MEMBERSHIPS.rmvfcAdmin,
      ]);

      const error = await expectDatabaseError(() => client.query('commit'));
      expect(error.code).toBe(PG_ERROR.checkViolation);
      expect(error.message).toContain('LEAGUE_ADMIN_CARDINALITY');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }

    const { rows } = await db.pool.query<{ status: string }>(
      `select status from public.league_memberships where id = $1`,
      [SEED_MEMBERSHIPS.rmvfcAdmin],
    );
    expect(rows[0]?.status).toBe('active');
  });

  it('rejects suspending the only active administrator, at COMMIT', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('begin');
      await client.query(`update public.league_memberships set status = 'suspended' where id = $1`, [
        SEED_MEMBERSHIPS.fivesAdmin,
      ]);
      const error = await expectDatabaseError(() => client.query('commit'));
      expect(error.message).toContain('LEAGUE_ADMIN_CARDINALITY');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  it('rejects deleting the only active administrator, at COMMIT', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('begin');
      await client.query(`delete from public.league_memberships where id = $1`, [
        SEED_MEMBERSHIPS.rmvfcAdmin,
      ]);
      const error = await expectDatabaseError(() => client.query('commit'));
      expect(error.message).toContain('LEAGUE_ADMIN_CARDINALITY');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  it('rejects committing a new league that has no administrator', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into public.leagues
           (name, slug, general_area, timezone, sport_label, description, default_capacity)
         values ('Orphan League', 'orphan-league', 'Nowhere',
                 'UTC', 'Soccer 7v7', 'A league with no administrator.', 14)`,
      );
      const error = await expectDatabaseError(() => client.query('commit'));
      expect(error.message).toContain('LEAGUE_ADMIN_CARDINALITY');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }

    const { rows } = await db.pool.query(`select 1 from public.leagues where slug = 'orphan-league'`);
    expect(rows).toHaveLength(0);
  });

  it('accepts a new league when its administrator is created in the same transaction', async () => {
    const client = await db.pool.connect();
    let leagueId: string | undefined;
    try {
      await client.query('begin');
      const { rows } = await client.query<{ id: string }>(
        `insert into public.leagues
           (name, slug, general_area, timezone, sport_label, description, default_capacity)
         values ('Sunday Futsal', 'sunday-futsal', 'Harbour district',
                 'Europe/Lisbon', 'Futsal 5v5', 'Sunday morning futsal.', 12)
         returning id`,
      );
      leagueId = rows[0]?.id;
      expect(leagueId).toBeDefined();

      await client.query(
        `insert into public.league_memberships (league_id, user_id, role, status)
         values ($1, $2, 'league_admin', 'active')`,
        [leagueId, SEED_USERS.outsider.id],
      );

      await client.query('commit');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }

    const { rows } = await db.pool.query<{ count: string }>(
      `select count(*)::text as count
         from public.league_memberships
        where league_id = $1 and role = 'league_admin' and status = 'active'`,
      [leagueId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('supports an atomic ownership transfer when the outgoing admin is demoted first', async () => {
    // This is the ordering a Phase 2 `transferLeagueAdministration` must use:
    // the partial unique index is intentionally NOT deferrable, so the seat
    // must be vacated before it is filled.
    const client = await db.pool.connect();
    try {
      await client.query('begin');
      await client.query(`update public.league_memberships set role = 'player' where id = $1`, [
        SEED_MEMBERSHIPS.rmvfcAdmin,
      ]);
      await client.query(`update public.league_memberships set role = 'league_admin' where id = $1`, [
        SEED_MEMBERSHIPS.rmvfcPlayer,
      ]);
      await client.query('commit');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }

    const { rows } = await db.pool.query<{ user_id: string }>(
      `select user_id from public.league_memberships
        where league_id = $1 and role = 'league_admin' and status = 'active'`,
      [SEED_LEAGUES.rmvfc],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(SEED_USERS.rmvfcPlayer.id);
  });

  it('rejects a transfer that promotes before demoting', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('begin');
      const error = await expectDatabaseError(() =>
        client.query(`update public.league_memberships set role = 'league_admin' where id = $1`, [
          SEED_MEMBERSHIPS.rmvfcPlayer,
        ]),
      );
      expect(error.code).toBe(PG_ERROR.uniqueViolation);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  it('does not require an administrator for a league deleted in the same transaction', async () => {
    await db.pool.query(`delete from public.leagues where id = $1`, [SEED_LEAGUES.weeknightFives]);

    const { rows } = await db.pool.query(`select 1 from public.leagues where id = $1`, [
      SEED_LEAGUES.weeknightFives,
    ]);
    expect(rows).toHaveLength(0);
  });
});

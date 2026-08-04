import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, SEED_LEAGUES, SEED_USERS, type TestDatabase } from './helpers/harness';

/**
 * Asserts that `supabase/seed.sql` contains exactly what the Phase 1 scope
 * requires. The suite applies the real seed file, so this doubles as proof that
 * the documented local setup path actually works.
 */
describe('development seed', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('seeded');
  });

  afterAll(async () => {
    await db.drop();
  });

  it('creates one private RMVFC-style league with default capacity 22', async () => {
    const { rows } = await db.pool.query<{
      name: string;
      visibility: string;
      timezone: string;
      default_capacity: number;
      default_selection_mode: string;
      default_waitlist_mode: string;
    }>(
      `select name, visibility, timezone, default_capacity,
              default_selection_mode, default_waitlist_mode
         from public.leagues where id = $1`,
      [SEED_LEAGUES.rmvfc],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('RMV Football Club');
    expect(rows[0]?.visibility).toBe('private');
    expect(rows[0]?.timezone).toBe('America/Los_Angeles');
    expect(rows[0]?.default_capacity).toBe(22);
    // The pilot's own rules, stored as league configuration rather than as
    // global product logic (PRD §7).
    expect(rows[0]?.default_selection_mode).toBe('admin_approval');
    expect(rows[0]?.default_waitlist_mode).toBe('admin_controlled');
  });

  it('creates one searchable 5v5 league with default capacity 10', async () => {
    const { rows } = await db.pool.query<{
      sport_label: string;
      visibility: string;
      default_capacity: number;
      default_selection_mode: string;
    }>(
      `select sport_label, visibility, default_capacity, default_selection_mode
         from public.leagues where id = $1`,
      [SEED_LEAGUES.weeknightFives],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sport_label).toBe('Soccer 5v5');
    expect(rows[0]?.visibility).toBe('searchable');
    expect(rows[0]?.default_capacity).toBe(10);
    expect(rows[0]?.default_selection_mode).toBe('first_come');
  });

  it('creates one player who actively belongs to both leagues', async () => {
    const { rows } = await db.pool.query<{ league_id: string; status: string; role: string }>(
      `select league_id, status, role from public.league_memberships
        where user_id = $1 order by league_id`,
      [SEED_USERS.multiLeaguePlayer.id],
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'active')).toBe(true);
    expect(rows.every((row) => row.role === 'player')).toBe(true);
    expect(new Set(rows.map((row) => row.league_id))).toEqual(
      new Set([SEED_LEAGUES.rmvfc, SEED_LEAGUES.weeknightFives]),
    );
  });

  it('gives each league exactly one active administrator', async () => {
    const { rows } = await db.pool.query<{ league_id: string; count: string }>(
      `select league_id, count(*)::text as count
         from public.league_memberships
        where role = 'league_admin' and status = 'active'
        group by league_id`,
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.count === '1')).toBe(true);
  });

  it('covers every membership status', async () => {
    const { rows } = await db.pool.query<{ status: string }>(
      'select distinct status from public.league_memberships',
    );
    expect(new Set(rows.map((row) => row.status))).toEqual(
      new Set(['pending', 'active', 'suspended', 'removed']),
    );
  });

  it('creates a signed-in-able auth user and identity for every profile', async () => {
    const { rows } = await db.pool.query<{ profiles: string; users: string; identities: string }>(
      `select
         (select count(*)::text from public.profiles) as profiles,
         (select count(*)::text from auth.users) as users,
         (select count(*)::text from auth.identities) as identities`,
    );
    expect(rows[0]?.profiles).toBe('8');
    expect(rows[0]?.users).toBe('8');
    expect(rows[0]?.identities).toBe('8');
  });

  it('uses only reserved .test email addresses, so nothing can be delivered', async () => {
    const { rows } = await db.pool.query<{ email_normalized: string }>(
      `select email_normalized from public.profiles where email_normalized not like '%@matchday.test'`,
    );
    expect(rows).toEqual([]);
  });

  it('stores no skill information for any seeded player', async () => {
    const { rows } = await db.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'profiles'`,
    );
    expect(rows.map((row) => row.column_name).filter((name) => /skill|rating/i.test(name))).toEqual(
      [],
    );
  });

  it('is re-runnable: applying it a second time leaves the same data', async () => {
    const { applySeed } = await import('./helpers/sql');
    const client = await db.pool.connect();
    try {
      await applySeed(client);
    } finally {
      client.release();
    }

    const { rows } = await db.pool.query<{ leagues: string; memberships: string; profiles: string }>(
      `select
         (select count(*)::text from public.leagues) as leagues,
         (select count(*)::text from public.league_memberships) as memberships,
         (select count(*)::text from public.profiles) as profiles`,
    );
    expect(rows[0]).toEqual({ leagues: '2', memberships: '8', profiles: '8' });
  });
});

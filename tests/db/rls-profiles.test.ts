import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

describe('RLS — profiles', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('seeded');
  });

  afterAll(async () => {
    await db.drop();
  });

  it('lets a user read their own profile', async () => {
    const rows = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
      const result = await client.query<{ id: string; first_name: string }>(
        'select id, first_name from public.profiles',
      );
      return result.rows;
    });

    expect(rows.map((row) => row.id)).toContain(SEED_USERS.multiLeaguePlayer.id);
  });

  it('hides other players from a player, even inside the same league', async () => {
    // Both are active members of RMVFC, yet neither can read the other's
    // private fields. Rosters (Phase 4) will expose names through a restricted
    // projection so that phone and gender never travel with them (PRD §12).
    const rows = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
      const result = await client.query<{ id: string }>('select id from public.profiles');
      return result.rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(SEED_USERS.multiLeaguePlayer.id);
  });

  it('lets a league administrator read the profiles of their own members', async () => {
    const ids = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
      const result = await client.query<{ id: string }>('select id from public.profiles');
      return result.rows.map((row) => row.id);
    });

    expect(ids).toContain(SEED_USERS.rmvfcPlayer.id);
    expect(ids).toContain(SEED_USERS.multiLeaguePlayer.id);
    expect(ids).toContain(SEED_USERS.suspendedPlayer.id);
  });

  it('hides the other league’s members from a league administrator', async () => {
    const ids = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
      const result = await client.query<{ id: string }>('select id from public.profiles');
      return result.rows.map((row) => row.id);
    });

    // The 5v5 administrator and the 5v5-only pending player are in a different
    // tenant entirely.
    expect(ids).not.toContain(SEED_USERS.fivesAdmin.id);
    expect(ids).not.toContain(SEED_USERS.pendingPlayer.id);
    expect(ids).not.toContain(SEED_USERS.outsider.id);
  });

  it('hides a removed member from their former administrator', async () => {
    const ids = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
      const result = await client.query<{ id: string }>('select id from public.profiles');
      return result.rows.map((row) => row.id);
    });

    expect(ids).not.toContain(SEED_USERS.removedPlayer.id);
  });

  it('shows a user with no memberships only their own profile', async () => {
    const rows = await asUser(db, SEED_USERS.outsider, async (client) => {
      const result = await client.query<{ id: string }>('select id from public.profiles');
      return result.rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(SEED_USERS.outsider.id);
  });

  it('lets a user update their own optional profile fields', async () => {
    const updated = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
      const result = await client.query<{ phone: string | null; goalkeeper_willing: boolean | null }>(
        `update public.profiles
            set phone = '+1-555-0199',
                goalkeeper_willing = true,
                preferred_positions = '{"Defence","Midfield"}'
          where id = $1
          returning phone, goalkeeper_willing`,
        [SEED_USERS.rmvfcPlayer.id],
      );
      return result.rows;
    });

    expect(updated).toHaveLength(1);
    expect(updated[0]?.phone).toBe('+1-555-0199');
    expect(updated[0]?.goalkeeper_willing).toBe(true);
  });

  it('silently affects no rows when a user tries to update someone else', async () => {
    // RLS turns an unauthorised UPDATE into a no-op rather than an error, so
    // the assertion is on the row count. A test that only checked "no
    // exception" would pass even if the write had gone through.
    const rowCount = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
      const result = await client.query(
        `update public.profiles set first_name = 'Hijacked' where id = $1`,
        [SEED_USERS.rmvfcAdmin.id],
      );
      return result.rowCount;
    });

    expect(rowCount).toBe(0);

    const { rows } = await db.pool.query<{ first_name: string }>(
      'select first_name from public.profiles where id = $1',
      [SEED_USERS.rmvfcAdmin.id],
    );
    expect(rows[0]?.first_name).toBe('Rosa');
  });

  it('does not let a league administrator edit a member’s profile', async () => {
    const rowCount = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
      const result = await client.query(
        `update public.profiles set gender = 'edited-by-admin' where id = $1`,
        [SEED_USERS.rmvfcPlayer.id],
      );
      return result.rowCount;
    });

    expect(rowCount).toBe(0);
  });

  it('rejects inserting a profile for another account', async () => {
    const error = await expectDatabaseError(() =>
      asUser(db, SEED_USERS.outsider, (client) =>
        client.query(
          `insert into public.profiles (id, first_name, last_name, email_normalized)
           values ($1, 'Forged', 'Profile', 'forged@matchday.test')`,
          [SEED_USERS.rmvfcAdmin.id],
        ),
      ),
    );

    expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
  });

  it('forces email_normalized to the verified session claim, ignoring client input', async () => {
    const email = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
      const result = await client.query<{ email_normalized: string }>(
        `update public.profiles
            set email_normalized = 'attacker@matchday.test'
          where id = $1
          returning email_normalized`,
        [SEED_USERS.rmvfcPlayer.id],
      );
      return result.rows[0]?.email_normalized;
    });

    expect(email).toBe(SEED_USERS.rmvfcPlayer.email);
  });

  it('gives an unauthenticated visitor no access to profiles at all', async () => {
    const error = await expectDatabaseError(() =>
      asAnon(db, (client) => client.query('select id from public.profiles')),
    );

    expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
  });
});

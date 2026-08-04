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
 * Data integrity that does not depend on the UI, the server actions, or the
 * client being well behaved (engineering requirement: "Include database
 * constraints instead of relying only on UI validation").
 *
 * These run with RLS bypassed so that a constraint, not a policy, is what
 * rejects each case.
 */
describe('database constraints', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  async function insertLeague(overrides: Record<string, unknown>): Promise<void> {
    const base: Record<string, unknown> = {
      name: 'Test League',
      slug: 'test-league',
      general_area: 'Test area',
      timezone: 'UTC',
      sport_label: 'Soccer 7v7',
      description: 'A league used by the constraint suite.',
      default_capacity: 14,
      ...overrides,
    };
    const columns = Object.keys(base);
    const placeholders = columns.map((_, index) => `$${index + 1}`);

    const client = await db.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query<{ id: string }>(
        `insert into public.leagues (${columns.join(', ')})
         values (${placeholders.join(', ')}) returning id`,
        Object.values(base),
      );
      // Satisfy the deferred single-administrator rule so that the *other*
      // constraint under test is the one that decides the outcome.
      await client.query(
        `insert into public.league_memberships (league_id, user_id, role, status)
         values ($1, $2, 'league_admin', 'active')`,
        [rows[0]?.id, SEED_USERS.outsider.id],
      );
      await client.query('commit');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  }

  describe('profiles', () => {
    it('rejects a blank first name', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query('update public.profiles set first_name = $1 where id = $2', [
          '   ',
          SEED_USERS.rmvfcPlayer.id,
        ]),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
      expect(error.message).toContain('profiles_first_name_length');
    });

    it('rejects an email that is not lower-cased', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query('update public.profiles set email_normalized = $1 where id = $2', [
          'MixedCase@matchday.test',
          SEED_USERS.rmvfcPlayer.id,
        ]),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
      expect(error.message).toContain('profiles_email_normalized_format');
    });

    it('rejects a malformed email', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query('update public.profiles set email_normalized = $1 where id = $2', [
          'not-an-email',
          SEED_USERS.rmvfcPlayer.id,
        ]),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
    });

    it('rejects a duplicate email regardless of capitalization at the source', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query('update public.profiles set email_normalized = $1 where id = $2', [
          SEED_USERS.rmvfcAdmin.email,
          SEED_USERS.rmvfcPlayer.id,
        ]),
      );
      expect(error.code).toBe(PG_ERROR.uniqueViolation);
      expect(error.message).toContain('profiles_email_normalized_key');
    });

    it('rejects a non-https profile photo URL', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query('update public.profiles set profile_photo_url = $1 where id = $2', [
          'javascript:alert(1)',
          SEED_USERS.rmvfcPlayer.id,
        ]),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
      expect(error.message).toContain('profiles_photo_url_scheme');
    });

    it('rejects an empty preferred position', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query('update public.profiles set preferred_positions = $1 where id = $2', [
          ['Midfield', '  '],
          SEED_USERS.rmvfcPlayer.id,
        ]),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
      expect(error.message).toContain('profiles_preferred_positions_valid');
    });

    it('rejects more than eight preferred positions', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query('update public.profiles set preferred_positions = $1 where id = $2', [
          ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
          SEED_USERS.rmvfcPlayer.id,
        ]),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
    });

    it('accepts a profile with every optional field left empty', async () => {
      const { rows } = await db.pool.query<{ gender: string | null }>(
        `update public.profiles
            set phone = null, gender = null, goalkeeper_willing = null,
                profile_photo_url = null, preferred_positions = '{}'
          where id = $1
          returning gender`,
        [SEED_USERS.multiLeaguePlayer.id],
      );
      expect(rows[0]?.gender).toBeNull();
    });
  });

  describe('leagues', () => {
    it('rejects an invalid slug', async () => {
      const error = await expectDatabaseError(() => insertLeague({ slug: 'Not A Slug' }));
      expect(error.code).toBe(PG_ERROR.checkViolation);
      expect(error.message).toContain('leagues_slug_format');
    });

    it('rejects a duplicate slug', async () => {
      const error = await expectDatabaseError(() => insertLeague({ slug: 'rmv-football-club' }));
      expect(error.code).toBe(PG_ERROR.uniqueViolation);
    });

    it('rejects a capacity below two', async () => {
      const error = await expectDatabaseError(() => insertLeague({ default_capacity: 1 }));
      expect(error.code).toBe(PG_ERROR.checkViolation);
      expect(error.message).toContain('leagues_default_capacity_range');
    });

    it('rejects a minimum threshold above capacity', async () => {
      const error = await expectDatabaseError(() =>
        insertLeague({ default_capacity: 10, default_min_players: 11 }),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
      expect(error.message).toContain('leagues_default_min_players_range');
    });

    it('accepts a minimum threshold equal to capacity', async () => {
      await expect(
        insertLeague({ slug: 'exact-threshold', default_capacity: 10, default_min_players: 10 }),
      ).resolves.toBeUndefined();
    });

    it('rejects an unrecognised timezone', async () => {
      const error = await expectDatabaseError(() =>
        insertLeague({ slug: 'bad-timezone', timezone: 'Mars/Olympus_Mons' }),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
      expect(error.message).toContain('INVALID_TIMEZONE');
    });

    it('accepts two leagues with completely different formats and capacities', async () => {
      const { rows } = await db.pool.query<{ slug: string; default_capacity: number }>(
        'select slug, default_capacity from public.leagues order by default_capacity',
      );
      expect(rows.map((row) => [row.slug, row.default_capacity])).toEqual([
        ['weeknight-5v5', 10],
        ['rmv-football-club', 22],
      ]);
    });

    it('rejects a non-object settings_json', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query('update public.leagues set settings_json = $1 where id = $2', [
          '"a string"',
          SEED_LEAGUES.rmvfc,
        ]),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
      expect(error.message).toContain('leagues_settings_json_is_object');
    });
  });

  describe('league memberships', () => {
    it('rejects a second membership for the same user in the same league', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.league_memberships (league_id, user_id, role, status)
           values ($1, $2, 'player', 'active')`,
          [SEED_LEAGUES.rmvfc, SEED_USERS.rmvfcPlayer.id],
        ),
      );
      expect(error.code).toBe(PG_ERROR.uniqueViolation);
      expect(error.message).toContain('league_memberships_league_user_key');
    });

    it('allows the same user in different leagues', async () => {
      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.league_memberships where user_id = $1`,
        [SEED_USERS.multiLeaguePlayer.id],
      );
      expect(Number(rows[0]?.count)).toBe(2);
    });

    it('rejects a suspension end date on a membership that is not suspended', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `update public.league_memberships set suspended_until = now() + interval '1 day'
            where id = $1 and status = 'active'`,
          [SEED_MEMBERSHIPS.rmvfcPlayer],
        ),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
      expect(error.message).toContain('league_memberships_suspended_until_requires_suspended');
    });

    it('clears the suspension end date when the member is reinstated', async () => {
      const { rows } = await db.pool.query<{ suspended_until: Date | null }>(
        `update public.league_memberships set status = 'active'
          where id = $1 returning suspended_until`,
        [SEED_MEMBERSHIPS.rmvfcSuspended],
      );
      expect(rows[0]?.suspended_until).toBeNull();
    });

    it('records the moment a status changes', async () => {
      const { rows } = await db.pool.query<{ changed: boolean }>(
        `update public.league_memberships set status = 'suspended'
          where id = $1
          returning (status_changed_at > created_at) as changed`,
        [SEED_MEMBERSHIPS.rmvfcPlayer],
      );
      expect(rows[0]?.changed).toBe(true);
    });
  });

  describe('administrator notes', () => {
    it('rejects a note whose league does not match its membership', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.league_membership_admin_notes (league_id, membership_id, note)
           values ($1, $2, 'Mislabelled note')`,
          [SEED_LEAGUES.weeknightFives, SEED_MEMBERSHIPS.rmvfcPlayer],
        ),
      );
      expect(error.code).toBe(PG_ERROR.foreignKeyViolation);
      expect(error.message).toContain('league_membership_admin_notes_membership_fk');
    });
  });

  describe('audit events', () => {
    it('rejects an action that does not follow the naming convention', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.audit_events (league_id, entity_type, action)
           values ($1, 'league', 'Not A Valid Action')`,
          [SEED_LEAGUES.rmvfc],
        ),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
      expect(error.message).toContain('audit_events_action_format');
    });

    it('rejects a non-object payload', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.audit_events (league_id, entity_type, action, after_data)
           values ($1, 'league', 'league.updated', '[]'::jsonb)`,
          [SEED_LEAGUES.rmvfc],
        ),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
      expect(error.message).toContain('audit_events_after_is_object');
    });

    it('requires a league on every audit event', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.audit_events (league_id, entity_type, action)
           values (null, 'league', 'league.updated')`,
        ),
      );
      expect(error.code).toBe(PG_ERROR.notNullViolation);
    });
  });
});

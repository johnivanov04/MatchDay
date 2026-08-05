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

/**
 * The public search projection.
 *
 * `searchable_leagues_public` is a SECURITY DEFINER view, so its WHERE clause —
 * not Row Level Security — is what keeps private leagues out of public results.
 * That makes it the single most security-critical object added in Phase 2, and
 * it is checked here from four independent angles: anonymous, authenticated
 * non-member, member of a *different* league, and column by column.
 */

/** Exactly the fields PRD §12 permits in a public or search result. */
const APPROVED_COLUMNS = [
  'description',
  'general_area',
  'id',
  'name',
  'slug',
  'sport_label',
  'typical_schedule',
];

/** Fields that must never be reachable through the public projection. */
const FORBIDDEN_COLUMNS = [
  'visibility',
  'default_location',
  'settings_json',
  'default_capacity',
  'default_min_players',
  'default_selection_mode',
  'default_waitlist_mode',
  'default_team_count',
  'position_labels',
  'gender_field_enabled',
  'goalkeeper_field_enabled',
  'logo_url',
  'public_contact',
  'created_by',
  'created_at',
  'updated_at',
];

describe('public league search', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('seeded');
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('projection', () => {
    it('exposes exactly the approved columns and no others', async () => {
      const { rows } = await db.pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'searchable_leagues_public'
          order by column_name`,
      );

      expect(rows.map((row) => row.column_name)).toEqual(APPROVED_COLUMNS);
    });

    it.each(FORBIDDEN_COLUMNS)('does not expose %s', async (column) => {
      const { rows } = await db.pool.query(
        `select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'searchable_leagues_public'
            and column_name = $1`,
        [column],
      );
      expect(rows).toEqual([]);
    });
  });

  describe('private leagues never appear', () => {
    it('is invisible to an anonymous visitor', async () => {
      const slugs = await asAnon(db, async (client) => {
        const result = await client.query<{ slug: string }>(
          'select slug from public.searchable_leagues_public',
        );
        return result.rows.map((row) => row.slug);
      });

      expect(slugs).toEqual(['weeknight-5v5']);
      expect(slugs).not.toContain('rmv-football-club');
    });

    it('is invisible to a signed-in non-member', async () => {
      const slugs = await asUser(db, SEED_USERS.outsider, async (client) => {
        const result = await client.query<{ slug: string }>(
          'select slug from public.searchable_leagues_public',
        );
        return result.rows.map((row) => row.slug);
      });

      expect(slugs).toEqual(['weeknight-5v5']);
    });

    it('is invisible even to its own administrator, through this view', async () => {
      // The view publishes what the world may see. Membership grants access to
      // the league through `leagues`, never through the public projection.
      const slugs = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ slug: string }>(
          'select slug from public.searchable_leagues_public',
        );
        return result.rows.map((row) => row.slug);
      });

      expect(slugs).not.toContain('rmv-football-club');
    });

    it('cannot be reached by filtering the view on its id', async () => {
      const rows = await asAnon(db, async (client) => {
        const result = await client.query(
          'select id from public.searchable_leagues_public where id = $1',
          [SEED_LEAGUES.rmvfc],
        );
        return result.rows;
      });

      expect(rows).toEqual([]);
    });
  });

  describe('the base table stays closed', () => {
    it('denies anon any access to leagues', async () => {
      const error = await expectDatabaseError(() =>
        asAnon(db, (client) => client.query('select id from public.leagues')),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('still hides the searchable league from a signed-in non-member', async () => {
      // Publishing a league does not widen `leagues` itself — only the seven
      // view columns become public.
      const rows = await asUser(db, SEED_USERS.outsider, async (client) => {
        const result = await client.query('select id from public.leagues');
        return result.rows;
      });
      expect(rows).toEqual([]);
    });

    it.each([
      ['profiles', 'select id from public.profiles'],
      ['league_memberships', 'select id from public.league_memberships'],
      ['league_join_requests', 'select id from public.league_join_requests'],
      ['league_invites', 'select id from public.league_invites'],
      ['audit_events', 'select id from public.audit_events'],
    ])('denies anon access to %s', async (_table, sql) => {
      const error = await expectDatabaseError(() => asAnon(db, (client) => client.query(sql)));
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });

  describe('visibility changes take effect', () => {
    it('publishes a league when it becomes searchable and withdraws it again', async () => {
      await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        await client.query(`update public.leagues set visibility = 'searchable' where id = $1`, [
          SEED_LEAGUES.rmvfc,
        ]);

        const published = await client.query(
          'select slug from public.searchable_leagues_public where id = $1',
          [SEED_LEAGUES.rmvfc],
        );
        expect(published.rowCount).toBe(1);

        await client.query(`update public.leagues set visibility = 'private' where id = $1`, [
          SEED_LEAGUES.rmvfc,
        ]);

        const withdrawn = await client.query(
          'select slug from public.searchable_leagues_public where id = $1',
          [SEED_LEAGUES.rmvfc],
        );
        expect(withdrawn.rowCount).toBe(0);
      });
    });
  });

  describe('search behaviour', () => {
    it('matches on name and on general area', async () => {
      const byName = await asAnon(db, async (client) => {
        const result = await client.query(
          `select slug from public.searchable_leagues_public where name ilike '%weeknight%'`,
        );
        return result.rowCount;
      });

      const byArea = await asAnon(db, async (client) => {
        const result = await client.query(
          `select slug from public.searchable_leagues_public where general_area ilike '%downtown%'`,
        );
        return result.rowCount;
      });

      expect(byName).toBe(1);
      expect(byArea).toBe(1);
    });
  });
});

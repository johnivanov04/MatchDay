import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asUser,
  asUserCommitting,
  createTestDatabase,
  expectDatabaseError,
  SEED_LEAGUES,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

/**
 * League-level match timing defaults.
 *
 * ── WHAT THESE COLUMNS ARE FOR ─────────────────────────────────────────────
 *
 * A league can now say "signup closes twelve hours before kickoff" once, and
 * every new match starts there. Before this, the four timing rules lived only
 * on individual matches and on templates, and creating a match without a
 * template fell back to constants compiled into the application.
 *
 * ── THE PROPERTY THAT MAKES IT SAFE ────────────────────────────────────────
 *
 * A match stores *resolved instants*, computed once at creation. A league
 * default is only ever read at that moment. So changing a default cannot reach
 * backwards into a match that already exists — which is asserted below rather
 * than assumed, because it is the whole reason this was safe to ship.
 */

const TWO_HOURS = '02:00:00';
const ONE_DAY = '1 day';

describe('league match timing defaults', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  describe('the schema', () => {
    it('has all four columns with the expected nullability', async () => {
      const { rows } = await db.pool.query<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable
           from information_schema.columns
          where table_schema = 'public' and table_name = 'leagues'
            and column_name in ('default_signup_closes_before',
                                'default_cancellation_cutoff_before',
                                'default_priority_window',
                                'default_roster_publish_before')
          order by column_name`,
      );

      expect(rows).toEqual([
        { column_name: 'default_cancellation_cutoff_before', is_nullable: 'NO' },
        { column_name: 'default_priority_window', is_nullable: 'YES' },
        { column_name: 'default_roster_publish_before', is_nullable: 'YES' },
        { column_name: 'default_signup_closes_before', is_nullable: 'NO' },
      ]);
    });

    it('defaults the two required ones to the values the application used to hard-code', async () => {
      const { rows } = await db.pool.query<{ column_name: string; column_default: string }>(
        `select column_name, column_default
           from information_schema.columns
          where table_schema = 'public' and table_name = 'leagues'
            and column_name in ('default_signup_closes_before',
                                'default_cancellation_cutoff_before')
          order by column_name`,
      );

      expect(rows[0]?.column_default).toContain('1 day');
      expect(rows[1]?.column_default).toContain('02:00:00');
    });

    it('leaves the optional two with no default, so "unset" survives', async () => {
      const { rows } = await db.pool.query<{ column_default: string | null }>(
        `select column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'leagues'
            and column_name in ('default_priority_window', 'default_roster_publish_before')`,
      );

      expect(rows.every((row) => row.column_default === null)).toBe(true);
    });
  });

  describe('the bounds', () => {
    const columns = [
      'default_signup_closes_before',
      'default_cancellation_cutoff_before',
      'default_priority_window',
      'default_roster_publish_before',
    ];

    it.each(columns)('refuses a negative %s', async (column) => {
      const error = await expectDatabaseError(() =>
        db.pool.query(`update public.leagues set ${column} = interval '-1 hours' where id = $1`, [
          SEED_LEAGUES.rmvfc,
        ]),
      );
      expect(error.message).toContain(`leagues_${column}_range`);
    });

    it.each(columns)('refuses more than 720 hours of %s', async (column) => {
      const error = await expectDatabaseError(() =>
        db.pool.query(`update public.leagues set ${column} = interval '721 hours' where id = $1`, [
          SEED_LEAGUES.rmvfc,
        ]),
      );
      expect(error.message).toContain(`leagues_${column}_range`);
    });

    it.each(columns)('accepts exactly 720 hours of %s', async (column) => {
      await expect(
        db.pool.query(`update public.leagues set ${column} = interval '720 hours' where id = $1`, [
          SEED_LEAGUES.rmvfc,
        ]),
      ).resolves.toBeTruthy();
    });

    it.each(['default_priority_window', 'default_roster_publish_before'])(
      'accepts null for the optional %s',
      async (column) => {
        await expect(
          db.pool.query(`update public.leagues set ${column} = null where id = $1`, [
            SEED_LEAGUES.rmvfc,
          ]),
        ).resolves.toBeTruthy();
      },
    );

    it('accepts zero, which is a real setting and not an absence', async () => {
      await expect(
        db.pool.query(
          `update public.leagues set default_signup_closes_before = interval '0' where id = $1`,
          [SEED_LEAGUES.rmvfc],
        ),
      ).resolves.toBeTruthy();
    });
  });

  describe('backwards compatibility', () => {
    it('backfills every league that existed before the migration', async () => {
      // The seed's leagues were written without these columns, so whatever
      // they hold came from the column defaults — which is exactly the
      // guarantee: no organizer has to configure anything.
      const { rows } = await db.pool.query<{
        signup: string;
        cutoff: string;
        priority: string | null;
        roster: string | null;
      }>(
        `select default_signup_closes_before::text as signup,
                default_cancellation_cutoff_before::text as cutoff,
                default_priority_window::text as priority,
                default_roster_publish_before::text as roster
           from public.leagues order by created_at`,
      );

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.signup).toBe(TWO_HOURS);
        expect(row.cutoff).toBe(ONE_DAY);
        expect(row.priority).toBeNull();
        expect(row.roster).toBeNull();
      }
    });

    it('left every pre-existing match untouched', async () => {
      // Seeded matches carry deadlines resolved before this migration existed.
      // Nothing in it rewrites a match, and this is the assertion that says so.
      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.matches
          where signup_closes_at is null or cancellation_cutoff_at is null`,
      );
      expect(rows[0]?.n).toBe('0');
    });

    it('left every pre-existing template untouched', async () => {
      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.match_templates
          where signup_closes_before is null or cancellation_cutoff_before is null`,
      );
      expect(rows[0]?.n).toBe('0');
    });
  });

  describe('create_league', () => {
    async function createLeague(
      actor: (typeof SEED_USERS)[keyof typeof SEED_USERS],
      timing = '',
    ): Promise<string> {
      const slug = `defaults-${Math.random().toString(36).slice(2, 10)}`;
      return asUserCommitting(db, actor, async (client) => {
        const result = await client.query<{ id: string }>(
          `select public.create_league(
             'Defaults League', $1, 'Testville', 'Europe/Berlin', 'Soccer 5v5',
             'A league for testing defaults.', 12, 6,
             'first_come', 'automatic', 2, null, null, false, false${timing}
           ) as id`,
          [slug],
        );
        return result.rows[0]?.id ?? '';
      });
    }

    async function timingOf(leagueId: string) {
      const { rows } = await db.pool.query<{
        signup: string;
        cutoff: string;
        priority: string | null;
        roster: string | null;
      }>(
        `select default_signup_closes_before::text as signup,
                default_cancellation_cutoff_before::text as cutoff,
                default_priority_window::text as priority,
                default_roster_publish_before::text as roster
           from public.leagues where id = $1`,
        [leagueId],
      );
      return rows[0];
    }

    it('uses the same defaults as the columns when the caller omits them', async () => {
      // The compatibility guarantee for any caller written before this change.
      const leagueId = await createLeague(SEED_USERS.rmvfcPlayer);

      expect(await timingOf(leagueId)).toEqual({
        signup: TWO_HOURS,
        cutoff: ONE_DAY,
        priority: null,
        roster: null,
      });
    });

    it('round-trips explicit values', async () => {
      const leagueId = await createLeague(
        SEED_USERS.rmvfcPlayer,
        `, interval '12 hours', interval '30 hours', interval '6 hours', interval '4 hours'`,
      );

      expect(await timingOf(leagueId)).toEqual({
        signup: '12:00:00',
        cutoff: '30:00:00',
        priority: '06:00:00',
        roster: '04:00:00',
      });
    });

    it('stores nulls for the optional two when asked to', async () => {
      const leagueId = await createLeague(
        SEED_USERS.rmvfcPlayer,
        `, interval '3 hours', interval '9 hours', null, null`,
      );

      const timing = await timingOf(leagueId);
      expect(timing?.priority).toBeNull();
      expect(timing?.roster).toBeNull();
    });

    it('treats an explicit null on a required field as "not chosen"', async () => {
      // The column is NOT NULL, so the alternative is an error nobody could act
      // on. `coalesce` in the function turns it back into the default.
      const leagueId = await createLeague(SEED_USERS.rmvfcPlayer, `, null, null, null, null`);

      const timing = await timingOf(leagueId);
      expect(timing?.signup).toBe(TWO_HOURS);
      expect(timing?.cutoff).toBe(ONE_DAY);
    });

    it('refuses out-of-range values through the function too', async () => {
      const error = await expectDatabaseError(() =>
        createLeague(SEED_USERS.rmvfcPlayer, `, interval '900 hours', interval '1 day', null, null`),
      );
      expect(error.message).toContain('leagues_default_signup_closes_before_range');
    });
  });

  describe('updating the defaults', () => {
    // Settings are written through the RLS-governed UPDATE on `leagues`, not a
    // dedicated RPC — `leagues_update_admin` is what authorizes it, and these
    // new columns are covered by it automatically because it is table-wide.
    const update = `update public.leagues
                       set default_signup_closes_before = interval '12 hours',
                           default_cancellation_cutoff_before = interval '30 hours',
                           default_priority_window = interval '6 hours',
                           default_roster_publish_before = interval '4 hours'
                     where id = $1`;

    it('lets the league administrator change all four', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(update, [SEED_LEAGUES.rmvfc]),
      );

      const { rows } = await db.pool.query<{ signup: string; priority: string | null }>(
        `select default_signup_closes_before::text as signup,
                default_priority_window::text as priority
           from public.leagues where id = $1`,
        [SEED_LEAGUES.rmvfc],
      );
      expect(rows[0]?.signup).toBe('12:00:00');
      expect(rows[0]?.priority).toBe('06:00:00');
    });

    it('refuses an ordinary player', async () => {
      const affected = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query(update, [SEED_LEAGUES.rmvfc]);
        return result.rowCount;
      });
      // RLS makes it a miss rather than an error.
      expect(affected).toBe(0);
    });

    it('refuses the administrator of a different league', async () => {
      const affected = await asUser(db, SEED_USERS.fivesAdmin, async (client) => {
        const result = await client.query(update, [SEED_LEAGUES.rmvfc]);
        return result.rowCount;
      });
      expect(affected).toBe(0);
    });
  });

  describe('execution privileges', () => {
    it('recreated create_league as SECURITY DEFINER with an empty search_path', async () => {
      const { rows } = await db.pool.query<{ prosecdef: boolean; proconfig: string[] | null }>(
        `select p.prosecdef, p.proconfig
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'create_league'`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.prosecdef).toBe(true);
      expect(rows[0]?.proconfig).toContain('search_path=""');
    });

    it('left exactly one create_league, not an overload beside the old one', async () => {
      // `CREATE OR REPLACE` with a different argument count would have created
      // a second function and left the timing-unaware one reachable.
      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'create_league'`,
      );
      expect(rows[0]?.n).toBe('1');
    });

    it('grants EXECUTE to authenticated and service_role, and to nobody else', async () => {
      const { rows } = await db.pool.query<{ acl: string[] | null }>(
        `select p.proacl::text[] as acl
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'create_league'`,
      );

      const acl = rows[0]?.acl ?? [];
      expect(acl.length).toBeGreaterThan(0);
      expect(acl.some((entry) => entry.startsWith('='))).toBe(false);
      expect(acl.some((entry) => entry.startsWith('authenticated='))).toBe(true);
      expect(acl.some((entry) => entry.startsWith('service_role='))).toBe(true);
    });
  });
});

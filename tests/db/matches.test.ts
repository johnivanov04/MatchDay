import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  asUserCommitting,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_LEAGUES,
  SEED_MATCHES,
  SEED_TEMPLATES,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

describe('match templates and matches', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  describe('templates are administrator-only', () => {
    it('lets the administrator read and write their own', async () => {
      const count = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query('select id from public.match_templates');
        return result.rowCount;
      });
      expect(count).toBe(2);
    });

    it('hides them from members entirely', async () => {
      for (const actor of [SEED_USERS.rmvfcPlayer, SEED_USERS.multiLeaguePlayer]) {
        const rows = await asUser(db, actor, async (client) => {
          const result = await client.query('select id from public.match_templates');
          return result.rows;
        });
        expect(rows).toEqual([]);
      }
    });

    it('hides another league’s templates from an administrator', async () => {
      const leagueIds = await asUser(db, SEED_USERS.fivesAdmin, async (client) => {
        const result = await client.query<{ league_id: string }>(
          'select league_id from public.match_templates',
        );
        return result.rows.map((row) => row.league_id);
      });
      expect(new Set(leagueIds)).toEqual(new Set([SEED_LEAGUES.weeknightFives]));
    });

    it('refuses a player writing one', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query(
            `insert into public.match_templates
               (league_id, name, arrival_time, kickoff_time, end_time, location_name, capacity)
             values ($1, 'Sneaky', '18:00', '19:00', '20:00', 'Somewhere', 10)`,
            [SEED_LEAGUES.rmvfc],
          ),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('enforces the same capacity rules as a match', async () => {
      for (const [column, value] of [
        ['capacity', 1],
        ['team_count', 1],
      ] as const) {
        const error = await expectDatabaseError(() =>
          db.pool.query(
            `update public.match_templates set ${column} = $2 where id = $1`,
            [SEED_TEMPLATES.rmvfcMonday, value],
          ),
        );
        expect(error.code).toBe(PG_ERROR.checkViolation);
      }
    });

    it('refuses a minimum above the capacity', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          'update public.match_templates set min_players = capacity + 1 where id = $1',
          [SEED_TEMPLATES.rmvfcMonday],
        ),
      );
      expect(error.message).toContain('match_templates_min_players_range');
    });
  });

  describe('draft invisibility', () => {
    it('hides drafts from members', async () => {
      const titles = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
        const result = await client.query<{ title: string }>(
          'select title from public.matches where league_id = $1',
          [SEED_LEAGUES.rmvfc],
        );
        return result.rows.map((row) => row.title);
      });

      expect(titles).toEqual(['Monday night 11v11']);
      expect(titles.join()).not.toContain('draft');
    });

    it('shows drafts to the administrator', async () => {
      const count = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query('select id from public.matches where league_id = $1', [
          SEED_LEAGUES.rmvfc,
        ]);
        return result.rowCount;
      });
      expect(count).toBe(2);
    });

    it('hides a draft even when its id is named directly', async () => {
      const rows = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
        const result = await client.query('select id from public.matches where id = $1', [
          SEED_MATCHES.rmvfcDraft,
        ]);
        return result.rows;
      });
      expect(rows).toEqual([]);
    });

    it('hides everything from a non-member and from anon', async () => {
      const rows = await asUser(db, SEED_USERS.outsider, async (client) => {
        const result = await client.query('select id from public.matches');
        return result.rows;
      });
      expect(rows).toEqual([]);

      const error = await expectDatabaseError(() =>
        asAnon(db, (client) => client.query('select id from public.matches')),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('shows a member only their own leagues’ matches', async () => {
      const leagueIds = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query<{ league_id: string }>(
          'select league_id from public.matches',
        );
        return result.rows.map((row) => row.league_id);
      });
      expect(new Set(leagueIds)).toEqual(new Set([SEED_LEAGUES.rmvfc]));
    });

    it('shows the multi-league player both leagues’ open matches', async () => {
      const leagueIds = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
        const result = await client.query<{ league_id: string }>(
          'select league_id from public.matches',
        );
        return result.rows.map((row) => row.league_id);
      });
      expect(new Set(leagueIds)).toEqual(
        new Set([SEED_LEAGUES.rmvfc, SEED_LEAGUES.weeknightFives]),
      );
    });
  });

  describe('administrator notes stay administrator-only', () => {
    it('is readable by the administrator', async () => {
      const count = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query('select notes from public.match_admin_notes');
        return result.rowCount;
      });
      expect(count).toBe(1);
    });

    it('is invisible to every member of the same league', async () => {
      for (const actor of [SEED_USERS.rmvfcPlayer, SEED_USERS.multiLeaguePlayer]) {
        const rows = await asUser(db, actor, async (client) => {
          const result = await client.query('select notes from public.match_admin_notes');
          return result.rows;
        });
        // The whole reason notes live in their own table: members must read the
        // match row, and a policy cannot hide one column of a readable row.
        expect(rows).toEqual([]);
      }
    });

    it('cannot be pointed at another league’s match', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.match_admin_notes (match_id, league_id, notes)
           values ($1, $2, 'Mislabelled')`,
          [SEED_MATCHES.fivesOpen, SEED_LEAGUES.rmvfc],
        ),
      );
      expect(error.code).toBe(PG_ERROR.foreignKeyViolation);
    });
  });

  describe('creating matches', () => {
    async function createMatch(
      actor: (typeof SEED_USERS)[keyof typeof SEED_USERS],
      overrides: Record<string, unknown> = {},
    ) {
      const input = {
        league: SEED_LEAGUES.rmvfc,
        title: 'Test match',
        date: '2026-09-14',
        arrival: '18:30',
        kickoff: '19:00',
        end: '20:30',
        location: 'RMV Community Pitch',
        capacity: 22,
        min: 14,
        ...overrides,
      };

      return asUserCommitting(db, actor, async (client) => {
        const result = await client.query<{ id: string }>(
          `select public.create_match($1,$2,$3,$4,$5,$6,$7,$8,$9,'admin_approval','admin_controlled') as id`,
          [
            input.league,
            input.title,
            input.date,
            input.arrival,
            input.kickoff,
            input.end,
            input.location,
            input.capacity,
            input.min,
          ],
        );
        return result.rows[0]?.id ?? '';
      });
    }

    it('creates a draft and audits it', async () => {
      const matchId = await createMatch(SEED_USERS.rmvfcAdmin);

      const { rows } = await db.pool.query<{ status: string; published_at: Date | null }>(
        'select status, published_at from public.matches where id = $1',
        [matchId],
      );
      expect(rows[0]?.status).toBe('draft');
      expect(rows[0]?.published_at).toBeNull();

      const audit = await db.pool.query<{ action: string }>(
        `select action from public.audit_events where entity_id = $1`,
        [matchId],
      );
      expect(audit.rows.map((row) => row.action)).toContain('match.created');
    });

    it('inherits the league timezone rather than accepting one', async () => {
      const matchId = await createMatch(SEED_USERS.rmvfcAdmin);
      const { rows } = await db.pool.query<{ timezone: string }>(
        'select timezone from public.matches where id = $1',
        [matchId],
      );
      expect(rows[0]?.timezone).toBe('America/Los_Angeles');
    });

    it('derives the deadlines from kickoff', async () => {
      const matchId = await createMatch(SEED_USERS.rmvfcAdmin);
      const { rows } = await db.pool.query<{ signup_lead: string; cancel_lead: string }>(
        `select (kickoff_at - signup_closes_at)::text as signup_lead,
                (kickoff_at - cancellation_cutoff_at)::text as cancel_lead
           from public.matches where id = $1`,
        [matchId],
      );
      // create_match's defaults: 2 hours and 1 day.
      expect(rows[0]?.signup_lead).toBe('02:00:00');
      expect(rows[0]?.cancel_lead).toBe('1 day');
    });

    it('refuses a player and another league’s administrator', async () => {
      for (const actor of [SEED_USERS.rmvfcPlayer, SEED_USERS.fivesAdmin]) {
        const error = await expectDatabaseError(() => createMatch(actor));
        expect(error.message).toContain('NOT_LEAGUE_ADMIN');
      }
    });

    it('refuses a template from another league', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `select public.create_match($1,'X','2026-09-14','18:30','19:00','20:30','P',22,14,
                                        'admin_approval','admin_controlled',2,$2)`,
            [SEED_LEAGUES.rmvfc, SEED_TEMPLATES.fivesThursday],
          ),
        ),
      );
      expect(error.message).toContain('MATCH_TEMPLATE_NOT_FOUND');
    });

    it('enforces capacity, threshold and team-count bounds', async () => {
      for (const overrides of [{ capacity: 1 }, { min: 30, capacity: 22 }]) {
        const error = await expectDatabaseError(() =>
          createMatch(SEED_USERS.rmvfcAdmin, overrides),
        );
        expect(error.code).toBe(PG_ERROR.checkViolation);
      }
    });

    it('refuses an end time before kickoff', async () => {
      const error = await expectDatabaseError(() =>
        createMatch(SEED_USERS.rmvfcAdmin, { kickoff: '20:00', end: '19:00' }),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
    });

    it('gives a client no direct insert path', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) =>
          client.query(
            `insert into public.matches
               (league_id, title, match_date, timezone, arrival_at, kickoff_at, end_at,
                location_name, capacity, min_players, selection_mode, waitlist_mode,
                signup_closes_at, cancellation_cutoff_at, status, published_at)
             values ($1,'Forged','2026-09-14','UTC', now(), now()+interval '1 hour',
                     now()+interval '2 hours','P',10,0,'first_come','automatic',
                     now(), now(), 'open', now())`,
            [SEED_LEAGUES.rmvfc],
          ),
        ),
      );
      // The INSERT policy requires status = 'draft'; publication is a separate,
      // audited step that also notifies members.
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });

  describe('lifecycle transitions', () => {
    it('refuses a jump to an unimplemented state', async () => {
      // `roster_finalized` moved out of this list in Phase 4, which implements
      // it. `teams_published` and `completed` stay: the enum names them so
      // later phases add behaviour rather than schema, and the guard stops
      // anything reaching a state no code understands.
      for (const target of ['teams_published', 'completed']) {
        const error = await expectDatabaseError(() =>
          db.pool.query('update public.matches set status = $2 where id = $1', [
            SEED_MATCHES.rmvfcOpen,
            target,
          ]),
        );
        expect(error.message).toContain('MATCH_TRANSITION_INVALID');
      }
    });

    it('allows open → roster_finalized, and back for further changes', async () => {
      await db.pool.query(`update public.matches set status = 'roster_finalized' where id = $1`, [
        SEED_MATCHES.rmvfcOpen,
      ]);
      await db.pool.query(`update public.matches set status = 'open' where id = $1`, [
        SEED_MATCHES.rmvfcOpen,
      ]);

      const { rows } = await db.pool.query<{ status: string }>(
        'select status from public.matches where id = $1',
        [SEED_MATCHES.rmvfcOpen],
      );
      // Reopening is how a late change is made before Phase 5 exists.
      expect(rows[0]?.status).toBe('open');
    });

    it('refuses teams_published even from a finalized roster', async () => {
      await db.pool.query(`update public.matches set status = 'roster_finalized' where id = $1`, [
        SEED_MATCHES.rmvfcOpen,
      ]);

      const error = await expectDatabaseError(() =>
        db.pool.query(`update public.matches set status = 'teams_published' where id = $1`, [
          SEED_MATCHES.rmvfcOpen,
        ]),
      );
      // Phase 6 adds this transition, not Phase 4.
      expect(error.message).toContain('MATCH_TRANSITION_INVALID');
    });

    it('refuses reopening a canceled match', async () => {
      await db.pool.query(
        `update public.matches set status = 'canceled', canceled_at = now() where id = $1`,
        [SEED_MATCHES.rmvfcOpen],
      );

      const error = await expectDatabaseError(() =>
        db.pool.query(`update public.matches set status = 'open' where id = $1`, [
          SEED_MATCHES.rmvfcOpen,
        ]),
      );
      expect(error.message).toContain('MATCH_TRANSITION_INVALID');
    });

    it('refuses a direct update of a published match', async () => {
      const rowCount = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query(
          `update public.matches set title = 'Renamed behind the scenes' where id = $1`,
          [SEED_MATCHES.rmvfcOpen],
        );
        return result.rowCount;
      });

      // "Published matches may be edited only through a deliberate audited
      // flow" — update_published_match() bumps the revision and notifies.
      expect(rowCount).toBe(0);
    });

    it('allows a draft to be edited directly', async () => {
      const rowCount = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query(
          `update public.matches set title = 'Revised draft' where id = $1`,
          [SEED_MATCHES.rmvfcDraft],
        );
        return result.rowCount;
      });
      expect(rowCount).toBe(1);
    });

    it('audits a draft edit', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(`update public.matches set title = 'Revised draft' where id = $1`, [
          SEED_MATCHES.rmvfcDraft,
        ]),
      );

      const { rows } = await db.pool.query<{ action: string }>(
        `select action from public.audit_events
          where entity_id = $1 and action = 'match.draft_updated'`,
        [SEED_MATCHES.rmvfcDraft],
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe('timezone and daylight saving', () => {
    /**
     * The two 2026 US transitions. `AT TIME ZONE` is the only implementation in
     * the stack that knows these rules, which is why the conversion lives in
     * the database rather than in JavaScript.
     */
    it('resolves 19:00 correctly on both sides of the spring transition', async () => {
      // Clocks go forward 2026-03-08 in America/Los_Angeles: PST (UTC-8) → PDT (UTC-7).
      // Rendered explicitly in UTC — a bare ::text would use whatever the
      // session timezone happens to be and prove nothing.
      const { rows } = await db.pool.query<{ before: string; after: string }>(
        `select ((('2026-03-07'::date + '19:00'::time) at time zone 'America/Los_Angeles')
                   at time zone 'UTC')::text as before,
                ((('2026-03-09'::date + '19:00'::time) at time zone 'America/Los_Angeles')
                   at time zone 'UTC')::text as after`,
      );

      // 19:00 PST is 03:00Z the next day; 19:00 PDT is 02:00Z the next day.
      expect(rows[0]?.before).toBe('2026-03-08 03:00:00');
      expect(rows[0]?.after).toBe('2026-03-10 02:00:00');
    });

    it('resolves 19:00 correctly on both sides of the autumn transition', async () => {
      // Clocks go back 2026-11-01: PDT (UTC-7) → PST (UTC-8).
      const { rows } = await db.pool.query<{ before: string; after: string }>(
        `select ((('2026-10-31'::date + '19:00'::time) at time zone 'America/Los_Angeles')
                   at time zone 'UTC')::text as before,
                ((('2026-11-02'::date + '19:00'::time) at time zone 'America/Los_Angeles')
                   at time zone 'UTC')::text as after`,
      );

      expect(rows[0]?.before).toBe('2026-11-01 02:00:00');
      expect(rows[0]?.after).toBe('2026-11-03 03:00:00');
    });

    it('keeps a match created across the transition at the same wall-clock time', async () => {
      const before = await asUserCommitting(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ id: string }>(
          `select public.create_match($1,'Before DST','2026-03-07','18:30','19:00','20:30',
                                      'P',22,14,'admin_approval','admin_controlled') as id`,
          [SEED_LEAGUES.rmvfc],
        );
        return result.rows[0]?.id ?? '';
      });

      const after = await asUserCommitting(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ id: string }>(
          `select public.create_match($1,'After DST','2026-03-09','18:30','19:00','20:30',
                                      'P',22,14,'admin_approval','admin_controlled') as id`,
          [SEED_LEAGUES.rmvfc],
        );
        return result.rows[0]?.id ?? '';
      });

      const { rows } = await db.pool.query<{ id: string; local: string }>(
        `select id, to_char(kickoff_at at time zone timezone, 'HH24:MI') as local
           from public.matches where id = any($1::uuid[])`,
        [[before, after]],
      );

      // Both read 19:00 locally, and they are a different number of hours apart
      // in UTC — which is exactly the behaviour a recurrence rule evaluated at
      // read time would get wrong.
      expect(rows.every((row) => row.local === '19:00')).toBe(true);
    });

    it('agrees with the TypeScript helper, including on both edge cases', async () => {
      // The database is authoritative for stored times and the helper drives
      // display. If they disagreed, the app would show a time nobody is
      // expected at — so they are compared directly, on the same inputs.
      const { zonedLocalTimeToInstant } = await import('@/lib/matches/match-timing');

      const cases = [
        { zone: 'America/Los_Angeles', date: '2026-01-15', time: '19:00' },
        { zone: 'America/Los_Angeles', date: '2026-07-15', time: '19:00' },
        { zone: 'America/Los_Angeles', date: '2026-03-07', time: '19:00' },
        // An ordinary evening ON each transition day. Both offsets exist
        // somewhere in these days but only one is real at 19:00, and reading
        // that hour back an hour out is what would move a match every time the
        // edit form was saved.
        { zone: 'America/Los_Angeles', date: '2026-03-08', time: '19:00' },
        { zone: 'America/Los_Angeles', date: '2026-11-01', time: '19:00' },
        { zone: 'America/Los_Angeles', date: '2026-03-09', time: '19:00' },
        { zone: 'America/Los_Angeles', date: '2026-03-08', time: '02:30' }, // does not exist
        { zone: 'America/Los_Angeles', date: '2026-10-31', time: '19:00' },
        { zone: 'America/Los_Angeles', date: '2026-11-01', time: '01:30' }, // happens twice
        { zone: 'America/Los_Angeles', date: '2026-11-02', time: '19:00' },
        // The southern hemisphere transitions the other way, on other dates.
        { zone: 'Pacific/Auckland', date: '2026-04-04', time: '19:00' },
        { zone: 'Pacific/Auckland', date: '2026-04-05', time: '19:00' },
        { zone: 'Pacific/Auckland', date: '2026-04-05', time: '02:30' }, // happens twice
        { zone: 'Pacific/Auckland', date: '2026-09-27', time: '19:00' },
        { zone: 'Pacific/Auckland', date: '2026-09-27', time: '02:30' }, // does not exist
        { zone: 'Pacific/Auckland', date: '2026-09-28', time: '19:00' },
        // A zone with a half-hour offset and no daylight saving at all.
        { zone: 'Asia/Kolkata', date: '2026-03-08', time: '19:00' },
      ];

      for (const input of cases) {
        const { rows } = await db.pool.query<{ instant: Date }>(
          `select (($1::date + $2::time) at time zone $3) as instant`,
          [input.date, input.time, input.zone],
        );

        const fromDatabase = rows[0]?.instant?.toISOString();
        const fromHelper = zonedLocalTimeToInstant(input, input.zone).toISOString();

        expect(fromHelper, `${input.zone} ${input.date} ${input.time}`).toBe(fromDatabase);
      }
    });

    it('agrees with the TypeScript helper on every hour of a whole year', async () => {
      // Hand-picked cases are what let the last disagreement through: they only
      // covered the two hours that are genuinely ambiguous, not the ordinary
      // evening on a transition day, and not a zone far enough east that the
      // helper's probe window fell on the wrong side of the change.
      //
      // So this compares every date at four times of day, in zones chosen for
      // how differently they behave, and lets PostgreSQL be the answer key.
      const { zonedLocalTimeToInstant } = await import('@/lib/matches/match-timing');

      const zones = [
        'America/Los_Angeles', // northern, whole-hour DST
        'Europe/London', // northern, transitions on different dates again
        'Pacific/Auckland', // southern, UTC+12/+13 — the far-east case
        'Australia/Lord_Howe', // half-hour DST shift
        'Asia/Kolkata', // permanent half-hour offset, no DST at all
        'UTC',
      ];

      for (const zone of zones) {
        const { rows } = await db.pool.query<{ date: string; time: string; instant: Date }>(
          `select d::date::text as date, t::text as time,
                  ((d::date + t) at time zone $1) as instant
             from generate_series('2026-01-01'::date, '2026-12-31'::date, interval '1 day') d
             cross join unnest(array['02:30'::time, '09:00', '19:00', '23:30']) t`,
          [zone],
        );

        expect(rows.length).toBe(365 * 4);

        for (const row of rows) {
          const fromHelper = zonedLocalTimeToInstant(
            { date: row.date, time: row.time.slice(0, 5) },
            zone,
          );
          expect(fromHelper.toISOString(), `${zone} ${row.date} ${row.time}`).toBe(
            row.instant.toISOString(),
          );
        }
      }
    });

    it('refuses an invalid timezone on a match row', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(`update public.matches set timezone = 'Mars/Olympus_Mons' where id = $1`, [
          SEED_MATCHES.rmvfcDraft,
        ]),
      );
      expect(error.message).toContain('INVALID_TIMEZONE');
    });
  });
});

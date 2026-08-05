import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asUser,
  asUserCommitting,
  createTestDatabase,
  expectDatabaseError,
  SEED_GUIDELINES,
  SEED_LEAGUES,
  SEED_MATCHES,
  SEED_TEMPLATES,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

/**
 * Cross-league isolation for everything Phase 3 adds, plus the deep-link
 * revocation property.
 *
 * The Phase 1 gate — "League A data is inaccessible from League B context" —
 * now has to hold for guidelines, templates, matches, administrator notes and
 * notifications as well.
 */
describe('Phase 3 cross-league isolation', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  describe('reads stay inside the tenant', () => {
    it.each([
      ['guideline_versions', 'select league_id from public.guideline_versions'],
      ['guideline_acceptances', 'select league_id from public.guideline_acceptances'],
      ['match_templates', 'select league_id from public.match_templates'],
      ['matches', 'select league_id from public.matches'],
      ['match_admin_notes', 'select league_id from public.match_admin_notes'],
    ])('shows the RMVFC administrator only RMVFC rows in %s', async (_table, sql) => {
      const leagueIds = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{ league_id: string }>(sql);
        return result.rows.map((row) => row.league_id);
      });

      expect(leagueIds.length).toBeGreaterThan(0);
      expect(new Set(leagueIds)).toEqual(new Set([SEED_LEAGUES.rmvfc]));
    });

    it('shows the 5v5 administrator only 5v5 rows', async () => {
      for (const sql of [
        'select league_id from public.guideline_versions',
        'select league_id from public.match_templates',
        'select league_id from public.matches',
      ]) {
        const leagueIds = await asUser(db, SEED_USERS.fivesAdmin, async (client) => {
          const result = await client.query<{ league_id: string }>(sql);
          return result.rows.map((row) => row.league_id);
        });

        expect(leagueIds.length).toBeGreaterThan(0);
        expect(new Set(leagueIds)).toEqual(new Set([SEED_LEAGUES.weeknightFives]));
      }
    });

    it('returns nothing when an administrator names another league’s row directly', async () => {
      const cases: Array<[string, string]> = [
        ['select id from public.guideline_versions where id = $1', SEED_GUIDELINES.fivesInformational],
        ['select id from public.match_templates where id = $1', SEED_TEMPLATES.fivesThursday],
        ['select id from public.matches where id = $1', SEED_MATCHES.fivesOpen],
      ];

      for (const [sql, id] of cases) {
        const rows = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
          const result = await client.query(sql, [id]);
          return result.rows;
        });
        expect(rows).toEqual([]);
      }
    });
  });

  describe('operations refuse to cross the boundary', () => {
    it.each([
      [
        'publishing another league’s guideline version',
        `select public.publish_guideline_version('${SEED_GUIDELINES.fivesInformational}')`,
      ],
      [
        'archiving another league’s guideline version',
        `select public.archive_guideline_version('${SEED_GUIDELINES.fivesInformational}')`,
      ],
      [
        'reading another league’s acceptance status',
        `select * from public.league_guideline_acceptance_status('${SEED_LEAGUES.weeknightFives}')`,
      ],
      [
        'publishing another league’s match',
        `select public.publish_match('${SEED_MATCHES.fivesOpen}')`,
      ],
      [
        'cancelling another league’s match',
        `select public.cancel_match('${SEED_MATCHES.fivesOpen}')`,
      ],
      [
        'creating a match in another league',
        `select public.create_match('${SEED_LEAGUES.weeknightFives}','X','2026-09-14',
                                    '18:30','19:00','20:30','P',10,8,
                                    'first_come','automatic')`,
      ],
    ])('refuses %s', async (_label, sql) => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcAdmin, (client) => client.query(sql)),
      );
      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
    });

    it('refuses accepting another league’s guidelines', async () => {
      // The RMVFC-only player is not a member of Weeknight 5v5.
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('select public.accept_guideline_version($1)', [
            SEED_GUIDELINES.fivesInformational,
          ]),
        ),
      );
      expect(error.message).toContain('MEMBERSHIP_REQUIRED');
    });
  });

  describe('the multi-league player sees exactly two leagues', () => {
    it('across guidelines and matches', async () => {
      const guidelineLeagues = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
        const result = await client.query<{ league_id: string }>(
          'select distinct league_id from public.guideline_versions',
        );
        return result.rows.map((row) => row.league_id);
      });

      const matchLeagues = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
        const result = await client.query<{ league_id: string }>(
          'select distinct league_id from public.matches',
        );
        return result.rows.map((row) => row.league_id);
      });

      const both = new Set([SEED_LEAGUES.rmvfc, SEED_LEAGUES.weeknightFives]);
      expect(new Set(guidelineLeagues)).toEqual(both);
      expect(new Set(matchLeagues)).toEqual(both);
    });

    it('and no administrator-only rows in either', async () => {
      const counts = await asUser(db, SEED_USERS.multiLeaguePlayer, async (client) => {
        const templates = await client.query('select id from public.match_templates');
        const notes = await client.query('select match_id from public.match_admin_notes');
        return { templates: templates.rowCount, notes: notes.rowCount };
      });

      expect(counts).toEqual({ templates: 0, notes: 0 });
    });
  });

  describe('deep links are re-authorized, not trusted', () => {
    it('stops a removed member reading the match a notification pointed at', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
      );

      // The notification exists and names the match.
      const before = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query('select id from public.matches where id = $1', [
          SEED_MATCHES.rmvfcDraft,
        ]);
        return result.rowCount;
      });
      expect(before).toBe(1);

      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(`update public.league_memberships set status = 'removed' where id = $1`, [
          '33333333-3333-4333-8333-000000000003',
        ]),
      );

      // The link still exists; the target no longer resolves for them.
      const after = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const match = await client.query('select id from public.matches where id = $1', [
          SEED_MATCHES.rmvfcDraft,
        ]);
        const guidelines = await client.query('select id from public.guideline_versions');
        return { match: match.rowCount, guidelines: guidelines.rowCount };
      });

      expect(after).toEqual({ match: 0, guidelines: 0 });
    });

    it('stops a suspended member reading member-only targets', async () => {
      const counts = await asUser(db, SEED_USERS.suspendedPlayer, async (client) => {
        const matches = await client.query('select id from public.matches');
        const guidelines = await client.query('select id from public.guideline_versions');
        return { matches: matches.rowCount, guidelines: guidelines.rowCount };
      });

      expect(counts).toEqual({ matches: 0, guidelines: 0 });
    });

    it('leaves the notification itself readable, so the inbox still renders', async () => {
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.publish_match($1)', [SEED_MATCHES.rmvfcDraft]),
      );
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query(`update public.league_memberships set status = 'removed' where id = $1`, [
          '33333333-3333-4333-8333-000000000003',
        ]),
      );

      // A notification is addressed to a person, not gated on membership. What
      // membership controls is whether the *target* opens.
      const rows = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
        const result = await client.query('select id from public.notifications');
        return result.rows;
      });
      expect(rows).toHaveLength(1);
    });
  });
});

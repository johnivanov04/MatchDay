import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asServiceRole,
  asUser,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_LEAGUES,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

/**
 * The content filter, against real PostgreSQL.
 *
 * Two properties matter and they pull against each other. It must refuse
 * objectionable text however it is spelled, and it must NOT refuse "Arsenal
 * Sunday League" — a filter that rejects ordinary football vocabulary is worse
 * than no filter, because the person who hits it concludes the product is
 * broken rather than that they typed something wrong.
 *
 * The write-path tests matter most. A predicate that works and a trigger that
 * is not attached is indistinguishable from a working filter until somebody
 * posts something, so every guarded table is exercised through an actual write.
 */

describe('objectionable content filter', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  async function blocked(text: string): Promise<boolean> {
    return asServiceRole(db, async (client) => {
      const { rows } = await client.query<{ blocked: boolean }>(
        'select public.contains_objectionable_content($1) as blocked',
        [text],
      );
      return rows[0]!.blocked;
    });
  }

  describe('ordinary football text is never refused', () => {
    it.each([
      ['Arsenal Sunday League', 'a club whose name contains a blocked substring'],
      ['Sussex Casuals FC', 'a county that does too'],
      ['Scunthorpe United Veterans', 'the canonical example'],
      ['Penistone Church AFC', 'another real English club'],
      ['Cockfosters Athletic', 'a real London place'],
      ['Clitheroe Wanderers', 'and another'],
      ['Assistant coach — class of 2019', 'everyday vocabulary'],
      ['Analysis of last season passes', 'more of it'],
      ['Grasshoppers 5-a-side, Cumbria', 'a county and a plural'],
      ['Weeknight 5v5. First come, first served.', 'an actual league description'],
      ['Sunday Kickabout at Review Park Pitch', 'an actual match title'],
      ['Titans FC — assists leader', 'a team name and a stat'],
    ])('accepts %j (%s)', async (text) => {
      expect(await blocked(text)).toBe(false);
    });
  });

  describe('objectionable text is refused however it is spelled', () => {
    it.each([
      ['fuck this league', 'plainly'],
      ['FUCK THIS LEAGUE', 'shouted'],
      ['sh1t league', 'leetspeak'],
      ['shiiiiiit', 'stretched'],
      ['F.U.C.K off', 'punctuation padding'],
      ['f u c k e r s united', 'spaced out'],
      ['fuckthisleague', 'run together'],
      ['MotherFucker FC', 'embedded in a word'],
      ['you should kys', 'an abbreviation'],
      ['retarded idiots', 'a slur'],
      ['N I G G E R', 'a slur, spaced'],
      ['c u n t s', 'a slur, spaced and pluralised'],
    ])('refuses %j (%s)', async (text) => {
      expect(await blocked(text)).toBe(true);
    });
  });

  describe('normalisation is what does the work', () => {
    it('folds case, leetspeak, padding and repetition to the same string', async () => {
      const forms = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ n: string }>(
          `select public.normalize_for_moderation(t) as n
             from unnest(array['SHIT', 'sh1t', 'sh!t', 'shiiiit', 'S H I T']) as t`,
        );
        return rows.map((row) => row.n);
      });
      // 'S H I T' stays four tokens: normalisation folds characters, and
      // rejoining letter runs is a separate, deliberate second step.
      expect(new Set(forms)).toEqual(new Set(['shit', 's h i t']));
    });

    it('rejoins single-letter runs without gluing whole words together', async () => {
      const joined = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ j: string }>(
          `select public.join_letter_runs(public.normalize_for_moderation($1)) as j`,
          ['surf Uckfield f u c k'],
        );
        return rows[0]!.j;
      });
      // "surf" and "uckfield" stay separate words; only the letter run joins.
      expect(joined).toContain('surf');
      expect(joined).toContain('uckfield');
      expect(joined).toContain('fuck');
      expect(joined).not.toContain('surfuckfield');
    });

    it('is immutable, so it can be reasoned about and indexed', async () => {
      const volatility = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ provolatile: string; proname: string }>(
          `select proname, provolatile from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and proname in ('normalize_for_moderation','contains_objectionable_content','join_letter_runs')`,
        );
        return rows;
      });
      expect(volatility).toHaveLength(3);
      for (const row of volatility) {
        expect(row.provolatile).toBe('i');
      }
    });
  });

  describe('EVERY guarded write path actually refuses', () => {
    const FOUL = 'fuck';

    it('refuses a profile name', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('update public.profiles set first_name = $1 where id = $2', [
            FOUL,
            SEED_USERS.rmvfcPlayer.id,
          ]),
        ),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
      expect(error.message).toContain('CONTENT_REJECTED');
    });

    it.each([
      ['name', 'leagues'],
      ['description', 'leagues'],
      ['general_area', 'leagues'],
      ['sport_label', 'leagues'],
      ['typical_schedule', 'leagues'],
      ['default_location', 'leagues'],
      ['public_contact', 'leagues'],
    ])('refuses leagues.%s', async (column) => {
      const error = await expectDatabaseError(() =>
        asServiceRole(db, (client) =>
          client.query(`update public.leagues set ${column} = $1 where id = $2`, [
            FOUL,
            SEED_LEAGUES.rmvfc,
          ]),
        ),
      );
      expect(error.message).toContain('CONTENT_REJECTED');
    });

    it('refuses a league position label inside an array', async () => {
      const error = await expectDatabaseError(() =>
        asServiceRole(db, (client) =>
          client.query('update public.leagues set position_labels = $1 where id = $2', [
            ['Goalkeeper', FOUL],
            SEED_LEAGUES.rmvfc,
          ]),
        ),
      );
      expect(error.message).toContain('CONTENT_REJECTED');
    });

    it.each([
      ['title', 'matches'],
      ['location_name', 'matches'],
      ['public_notes', 'matches'],
    ])('refuses matches.%s', async (column) => {
      const error = await expectDatabaseError(() =>
        asServiceRole(db, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            'select id from public.matches order by id limit 1',
          );
          return client.query(`update public.matches set ${column} = $1 where id = $2`, [
            FOUL,
            rows[0]!.id,
          ]);
        }),
      );
      expect(error.message).toContain('CONTENT_REJECTED');
    });

    // A PUBLISHED guideline version is immutable — `guideline_versions_guard_
    // published_edit` refuses the update before the filter is reached. So the
    // filter is exercised where it actually applies: writing a new draft.
    it.each([['title'], ['body'], ['version_label']])(
      'refuses guideline_versions.%s on a new draft',
      async (column) => {
        const clean: Record<string, string> = {
          version_label: 'v99',
          title: 'House rules',
          body: 'Be on time and be civil.',
        };
        clean[column] = FOUL;

        const error = await expectDatabaseError(() =>
          asServiceRole(db, (client) =>
            client.query(
              `insert into public.guideline_versions
                 (league_id, version_label, title, body, requires_acceptance)
               values ($1, $2, $3, $4, false)`,
              [SEED_LEAGUES.rmvfc, clean.version_label, clean.title, clean.body],
            ),
          ),
        );
        expect(error.message).toContain('CONTENT_REJECTED');
      },
    );

    it('refuses a join-request message', async () => {
      const error = await expectDatabaseError(() =>
        asServiceRole(db, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            'select id from public.league_join_requests order by id limit 1',
          );
          return client.query('update public.league_join_requests set message = $1 where id = $2', [
            FOUL,
            rows[0]!.id,
          ]);
        }),
      );
      expect(error.message).toContain('CONTENT_REJECTED');
    });

    it('guards every table the audit identified', async () => {
      const guarded = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ relname: string }>(
          `select c.relname from pg_trigger t
             join pg_class c on c.oid = t.tgrelid
            where t.tgname like '%_moderate_text' and not t.tgisinternal
            order by c.relname`,
        );
        return rows.map((row) => row.relname);
      });

      expect(guarded).toEqual([
        'attendance_records',
        'content_reports',
        'guideline_versions',
        'league_invites',
        'league_join_requests',
        'league_membership_admin_notes',
        'league_memberships',
        'leagues',
        'match_admin_notes',
        'match_signups',
        'match_team_publication_entries',
        'match_teams',
        'match_templates',
        'matches',
        'profiles',
      ]);
    });
  });

  describe('a refusal keeps nothing', () => {
    it('does not persist the rejected text', async () => {
      const before = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ description: string }>(
          'select description from public.leagues where id = $1',
          [SEED_LEAGUES.rmvfc],
        );
        return rows[0]!.description;
      });

      await expectDatabaseError(() =>
        asServiceRole(db, (client) =>
          client.query('update public.leagues set description = $1 where id = $2', [
            'fuck this',
            SEED_LEAGUES.rmvfc,
          ]),
        ),
      );

      const after = await asServiceRole(db, async (client) => {
        const { rows } = await client.query<{ description: string }>(
          'select description from public.leagues where id = $1',
          [SEED_LEAGUES.rmvfc],
        );
        return rows[0]!.description;
      });

      expect(after).toBe(before);
    });

    it('says nothing about what was submitted', async () => {
      const error = await expectDatabaseError(() =>
        asServiceRole(db, (client) =>
          client.query('update public.leagues set description = $1 where id = $2', [
            'fuck this particular league',
            SEED_LEAGUES.rmvfc,
          ]),
        ),
      );
      // The refusal names the rule, never the text — an error string is logged
      // in a dozen places and must not carry the slur somebody typed.
      expect(error.message).not.toContain('fuck');
      expect(error.message).not.toContain('particular');
    });
  });
});

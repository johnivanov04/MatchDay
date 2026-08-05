import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asUser,
  asUserCommitting,
  createTestDatabase,
  SEED_GUIDELINES,
  SEED_LEAGUES,
  SEED_USERS,
  type TestDatabase,
} from './helpers/harness';

/**
 * The signup-eligibility predicate Phase 4 will call on every signup attempt.
 *
 * The property that matters most is the tenant boundary: an unaccepted
 * guideline in one league must never affect another. The multi-league player is
 * the fixture that proves it, because they are active in both.
 */
describe('guideline eligibility predicate', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  async function eligible(
    user: (typeof SEED_USERS)[keyof typeof SEED_USERS],
    leagueId: string,
  ): Promise<boolean | null> {
    return asUser(db, user, async (client) => {
      const result = await client.query<{ ok: boolean }>(
        'select public.has_accepted_required_guidelines($1) as ok',
        [leagueId],
      );
      return result.rows[0]?.ok ?? null;
    });
  }

  it('is true for a member who has accepted the required version', async () => {
    expect(await eligible(SEED_USERS.multiLeaguePlayer, SEED_LEAGUES.rmvfc)).toBe(true);
  });

  it('is false for a member who has not', async () => {
    expect(await eligible(SEED_USERS.rmvfcPlayer, SEED_LEAGUES.rmvfc)).toBe(false);
  });

  it('is true when the league requires nothing', async () => {
    // Weeknight 5v5's published version is informational.
    expect(await eligible(SEED_USERS.multiLeaguePlayer, SEED_LEAGUES.weeknightFives)).toBe(true);
  });

  it('blocks only the league that published the version', async () => {
    // The same person, the same instant, two different answers — this is the
    // whole tenancy requirement in one assertion.
    expect(await eligible(SEED_USERS.rmvfcPlayer, SEED_LEAGUES.rmvfc)).toBe(false);
    expect(await eligible(SEED_USERS.multiLeaguePlayer, SEED_LEAGUES.weeknightFives)).toBe(true);
  });

  it('turns a compliant member non-compliant when a new required version is published', async () => {
    expect(await eligible(SEED_USERS.multiLeaguePlayer, SEED_LEAGUES.rmvfc)).toBe(true);

    const newVersion = await asUserCommitting(db, SEED_USERS.rmvfcAdmin, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `insert into public.guideline_versions
           (league_id, version_label, title, body, requires_acceptance, effective_at)
         values ($1, '2027-revision', 'Revised', 'New rules.', true, now())
         returning id`,
        [SEED_LEAGUES.rmvfc],
      );
      return inserted.rows[0]?.id ?? '';
    });

    await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
      client.query('select public.publish_guideline_version($1)', [newVersion]),
    );

    // Their old acceptance stands as history, but it is not this version.
    expect(await eligible(SEED_USERS.multiLeaguePlayer, SEED_LEAGUES.rmvfc)).toBe(false);
    // And the other league is untouched.
    expect(await eligible(SEED_USERS.multiLeaguePlayer, SEED_LEAGUES.weeknightFives)).toBe(true);

    await asUserCommitting(db, SEED_USERS.multiLeaguePlayer, (client) =>
      client.query('select public.accept_guideline_version($1)', [newVersion]),
    );

    expect(await eligible(SEED_USERS.multiLeaguePlayer, SEED_LEAGUES.rmvfc)).toBe(true);
  });

  it('stops requiring anything once the required version is archived', async () => {
    expect(await eligible(SEED_USERS.rmvfcPlayer, SEED_LEAGUES.rmvfc)).toBe(false);

    await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
      client.query('select public.archive_guideline_version($1)', [
        SEED_GUIDELINES.rmvfcRequired,
      ]),
    );

    expect(await eligible(SEED_USERS.rmvfcPlayer, SEED_LEAGUES.rmvfc)).toBe(true);
  });

  it('ignores a version whose effective date has not arrived', async () => {
    const future = await asUserCommitting(db, SEED_USERS.rmvfcAdmin, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `insert into public.guideline_versions
           (league_id, version_label, title, body, requires_acceptance, effective_at)
         values ($1, 'future', 'Future', 'Not yet.', true, now() + interval '30 days')
         returning id`,
        [SEED_LEAGUES.rmvfc],
      );
      return inserted.rows[0]?.id ?? '';
    });

    await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
      client.query('select public.publish_guideline_version($1)', [future]),
    );

    // The currently effective version is still the one they accepted.
    expect(await eligible(SEED_USERS.multiLeaguePlayer, SEED_LEAGUES.rmvfc)).toBe(true);
  });

  it('ignores a draft, however recent', async () => {
    await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
      client.query(
        `insert into public.guideline_versions
           (league_id, version_label, title, body, requires_acceptance, effective_at)
         values ($1, 'unpublished', 'Draft', 'Unpublished.', true, now())`,
        [SEED_LEAGUES.rmvfc],
      ),
    );

    expect(await eligible(SEED_USERS.multiLeaguePlayer, SEED_LEAGUES.rmvfc)).toBe(true);
  });

  it('ignores an informational version even when it is the newest', async () => {
    const informational = await asUserCommitting(db, SEED_USERS.rmvfcAdmin, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `insert into public.guideline_versions
           (league_id, version_label, title, body, requires_acceptance, effective_at)
         values ($1, 'fyi', 'FYI', 'No acceptance needed.', false, now())
         returning id`,
        [SEED_LEAGUES.rmvfc],
      );
      return inserted.rows[0]?.id ?? '';
    });

    await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
      client.query('select public.publish_guideline_version($1)', [informational]),
    );

    // The required version is still the older one, which they accepted.
    expect(await eligible(SEED_USERS.multiLeaguePlayer, SEED_LEAGUES.rmvfc)).toBe(true);
    expect(await eligible(SEED_USERS.rmvfcPlayer, SEED_LEAGUES.rmvfc)).toBe(false);
  });

  it('is false for a non-member and for a suspended member', async () => {
    expect(await eligible(SEED_USERS.outsider, SEED_LEAGUES.rmvfc)).toBe(false);
    expect(await eligible(SEED_USERS.suspendedPlayer, SEED_LEAGUES.rmvfc)).toBe(false);
  });

  it('answers only about the caller, never about a named user', async () => {
    // The function takes a league and nothing else. There is no signature that
    // could be used to probe whether somebody else has accepted, which is what
    // keeps it from becoming a membership oracle.
    const { rows } = await db.pool.query<{ args: string }>(
      `select pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'has_accepted_required_guidelines'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.args).toBe('p_league_id uuid');
  });
});

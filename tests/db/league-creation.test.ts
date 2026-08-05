import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  asUserCommitting,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_USERS,
  type SeedUser,
  type TestDatabase,
} from './helpers/harness';

const NEW_LEAGUE = {
  name: 'Sunday Futsal',
  slug: 'sunday-futsal',
  area: 'Harbour district',
  timezone: 'Europe/Lisbon',
  sport: 'Futsal 5v5',
  description: 'Sunday morning futsal.',
  capacity: 12,
};

async function createLeagueAs(
  db: TestDatabase,
  // `SeedUser`, not the seed union: one case deliberately uses an account that
  // has authenticated but has no profile row.
  user: SeedUser,
  overrides: Partial<typeof NEW_LEAGUE> = {},
  commit = false,
): Promise<string> {
  const input = { ...NEW_LEAGUE, ...overrides };
  const run = commit ? asUserCommitting : asUser;

  return run(db, user, async (client) => {
    const result = await client.query<{ create_league: string }>(
      `select public.create_league($1, $2, $3, $4, $5, $6, $7) as create_league`,
      [
        input.name,
        input.slug,
        input.area,
        input.timezone,
        input.sport,
        input.description,
        input.capacity,
      ],
    );
    return result.rows[0]?.create_league ?? '';
  });
}

describe('league creation', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  it('creates the league and its administrator in one transaction', async () => {
    // Committing matters here: the Phase 1 deferred constraint only fires at
    // COMMIT, so a test that rolled back would pass even if create_league
    // forgot the membership entirely.
    const leagueId = await createLeagueAs(db, SEED_USERS.outsider, {}, true);

    const { rows } = await db.pool.query<{ user_id: string; role: string; status: string }>(
      `select user_id, role, status from public.league_memberships where league_id = $1`,
      [leagueId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: SEED_USERS.outsider.id,
      role: 'league_admin',
      status: 'active',
    });
  });

  it('makes the new league private, whatever the caller wants', async () => {
    // `visibility` is not a parameter of create_league at all, so there is
    // nothing for a client to pass. This asserts the resulting state.
    const leagueId = await createLeagueAs(db, SEED_USERS.outsider, {}, true);

    const { rows } = await db.pool.query<{ visibility: string }>(
      'select visibility from public.leagues where id = $1',
      [leagueId],
    );
    expect(rows[0]?.visibility).toBe('private');
  });

  it('keeps the new league out of public search', async () => {
    await createLeagueAs(db, SEED_USERS.outsider, {}, true);

    const slugs = await asAnon(db, async (client) => {
      const result = await client.query<{ slug: string }>(
        'select slug from public.searchable_leagues_public',
      );
      return result.rows.map((row) => row.slug);
    });

    expect(slugs).not.toContain(NEW_LEAGUE.slug);
  });

  it('records league.created and membership.created', async () => {
    const leagueId = await createLeagueAs(db, SEED_USERS.outsider, {}, true);

    const { rows } = await db.pool.query<{ action: string; actor_user_id: string }>(
      'select action, actor_user_id from public.audit_events where league_id = $1 order by action',
      [leagueId],
    );

    expect(rows.map((row) => row.action)).toEqual(['league.created', 'membership.created']);
    expect(rows.every((row) => row.actor_user_id === SEED_USERS.outsider.id)).toBe(true);
  });

  it('makes the new league the creator’s active league', async () => {
    const leagueId = await createLeagueAs(db, SEED_USERS.outsider, {}, true);

    const { rows } = await db.pool.query<{ active_league_id: string }>(
      'select active_league_id from public.user_app_state where user_id = $1',
      [SEED_USERS.outsider.id],
    );
    expect(rows[0]?.active_league_id).toBe(leagueId);
  });

  it('lets someone who already administers a league create another', async () => {
    const leagueId = await createLeagueAs(db, SEED_USERS.rmvfcAdmin, {}, true);

    const { rows } = await db.pool.query<{ count: string }>(
      `select count(*)::text as count from public.league_memberships
        where user_id = $1 and role = 'league_admin' and status = 'active'`,
      [SEED_USERS.rmvfcAdmin.id],
    );
    expect(Number(rows[0]?.count)).toBe(2);
    expect(leagueId).not.toBe('');
  });

  it('rejects a duplicate slug', async () => {
    const error = await expectDatabaseError(() =>
      createLeagueAs(db, SEED_USERS.outsider, { slug: 'rmv-football-club' }),
    );

    expect(error.code).toBe(PG_ERROR.uniqueViolation);
    expect(error.message).toContain('leagues_slug_key');
  });

  it('rejects an unauthenticated caller', async () => {
    const error = await expectDatabaseError(() =>
      asAnon(db, (client) =>
        client.query(
          `select public.create_league('X League','x-league','Area','UTC','Soccer','Desc',10)`,
        ),
      ),
    );

    expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
  });

  it('rejects a signed-in user who has no profile yet', async () => {
    const stranger = {
      id: '11111111-1111-4111-8111-0000000000ff',
      email: 'no.profile@matchday.test',
    };

    const error = await expectDatabaseError(() => createLeagueAs(db, stranger));
    expect(error.message).toContain('PROFILE_INCOMPLETE');
  });

  it('rejects an invalid timezone through the database trigger', async () => {
    const error = await expectDatabaseError(() =>
      createLeagueAs(db, SEED_USERS.outsider, { timezone: 'Mars/Olympus_Mons' }),
    );
    expect(error.message).toContain('INVALID_TIMEZONE');
  });

  it('rejects a capacity outside the permitted range', async () => {
    const error = await expectDatabaseError(() =>
      createLeagueAs(db, SEED_USERS.outsider, { capacity: 1 }),
    );
    expect(error.code).toBe(PG_ERROR.checkViolation);
  });

  it('leaves the new league invisible to everyone else', async () => {
    await createLeagueAs(db, SEED_USERS.outsider, {}, true);

    const visible = await asUser(db, SEED_USERS.rmvfcPlayer, async (client) => {
      const result = await client.query<{ slug: string }>('select slug from public.leagues');
      return result.rows.map((row) => row.slug);
    });

    expect(visible).toEqual(['rmv-football-club']);
  });
});

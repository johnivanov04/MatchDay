import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  asUserCommitting,
  createExtraMembers,
  createTestDatabase,
  SEED_LEAGUES,
  SEED_MATCHES,
  SEED_USERS,
  type ExtraMember,
  type SeedUser,
  type TestDatabase,
} from './helpers/harness';

/**
 * Phase 2 of profile photos: an avatar travels exactly as far as the name it
 * sits beside, and not one row further.
 *
 * ── WHAT THIS FILE IS FOR ──────────────────────────────────────────────────
 *
 * Five SECURITY DEFINER projections gained one column. Each of them already
 * decided who may see a player's name, so the *authorization* work was done
 * years of phases ago and none of it was touched. What has to be proved is that
 * it stayed untouched — that adding a column to a select list did not quietly
 * change who receives rows — and that the column added is the harmless one.
 *
 * So every projection below is checked three ways: an authorized caller gets
 * the path, an unauthorized caller still gets **nothing at all**, and the
 * result's column set is asserted **exactly**. The exact-column assertions are
 * the ones that matter most: a future migration that adds `p.phone` or
 * `p.profile_photo_url` to any of these fails here loudly rather than shipping
 * a leak nobody notices.
 *
 * ── WHY `profile_photo_url` IS THE SPECIFIC ENEMY ──────────────────────────
 *
 * The legacy column holds an arbitrary https address on a host nobody here
 * controls. Rendering one inside another member's browser would disclose that
 * member's IP address and user agent to whoever operates it, on a page they
 * never chose to visit. It is the one profile column that is dangerous *because*
 * it is rendered, rather than because of what it says.
 */

/** `{uuid}/{uuid}.jpg` — the shape `profiles_photo_path_shape` enforces. */
const AVATAR_PATH = (userId: string, file = 'a0000000-0000-4000-8000-000000000001') =>
  `${userId}/${file}.jpg`;

const LEGACY_URL = 'https://cdn.elsewhere.test/people/legacy.jpg';

describe('player avatar projections', () => {
  let db: TestDatabase;
  let members: ExtraMember[];

  const admin = SEED_USERS.fivesAdmin;
  const match = SEED_MATCHES.fivesOpen;
  const league = SEED_LEAGUES.weeknightFives;

  /** Belongs to the *other* league entirely. */
  const outsider: SeedUser = SEED_USERS.rmvfcPlayer;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
    await db.pool.query('update public.matches set capacity = 8, min_players = 1 where id = $1', [
      match,
    ]);
    members = await createExtraMembers(db, league, 4);
  });

  afterEach(async () => {
    await db.drop();
  });

  // ── Fixture helpers ──────────────────────────────────────────────────────

  async function join(member: ExtraMember) {
    await asUserCommitting(db, member.user, (client) =>
      client.query('select public.join_match($1)', [match]),
    );
  }

  async function joinAll(count = 4) {
    for (const member of members.slice(0, count)) {
      await join(member);
    }
  }

  async function callAdmin<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
    user: SeedUser = admin,
  ): Promise<T[]> {
    return asUserCommitting(db, user, async (client) => {
      const result = await client.query<T>(sql, params);
      return result.rows;
    });
  }

  /** Gives a member a managed avatar, written the way the upload action does. */
  async function setAvatarPath(user: SeedUser, path: string | null) {
    await db.pool.query('update public.profiles set profile_photo_path = $1 where id = $2', [
      path,
      user.id,
    ]);
  }

  /** Gives a member a legacy pasted address and no managed object. */
  async function setLegacyUrl(user: SeedUser, url: string | null) {
    await db.pool.query('update public.profiles set profile_photo_url = $1 where id = $2', [
      url,
      user.id,
    ]);
  }

  /** Column names of a projection, as the caller receives them. */
  async function columnsFor(
    sql: string,
    user: SeedUser,
    params: unknown[] = [match],
  ): Promise<string[]> {
    return asUser(db, user, async (client) => {
      const result = await client.query(sql, params);
      return result.fields.map((field) => field.name).sort();
    });
  }

  async function rowsFor<T extends Record<string, unknown>>(
    sql: string,
    user: SeedUser,
    params: unknown[] = [match],
  ): Promise<T[]> {
    return asUser(db, user, async (client) => {
      const result = await client.query<T>(sql, params);
      return result.rows;
    });
  }

  async function publishTeams() {
    await callAdmin('select public.ensure_match_teams($1)', [match]);
    await callAdmin('select public.randomize_match_teams($1)', [match]);
    await callAdmin('select public.publish_match_teams($1)', [match]);
  }

  async function endMatchAndConfirm() {
    await db.pool.query(
      `update public.matches
          set match_date = match_date - interval '10 days',
              arrival_at = arrival_at - interval '10 days',
              kickoff_at = kickoff_at - interval '10 days',
              end_at = end_at - interval '10 days',
              signup_closes_at = signup_closes_at - interval '10 days',
              cancellation_cutoff_at = cancellation_cutoff_at - interval '10 days',
              roster_publish_target_at = roster_publish_target_at - interval '10 days'
        where id = $1`,
      [match],
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. match_confirmed_roster — member-facing
  // ══════════════════════════════════════════════════════════════════════════

  describe('match_confirmed_roster', () => {
    const SQL = 'select * from public.match_confirmed_roster($1)';

    beforeEach(async () => {
      await joinAll(3);
      await setAvatarPath(members[0]!.user, AVATAR_PATH(members[0]!.user.id));
    });

    it('gives an active member another member managed avatar path', async () => {
      const rows = await rowsFor<{ membership_id: string; profile_photo_path: string | null }>(
        SQL,
        members[1]!.user,
      );

      const other = rows.find((row) => row.membership_id === members[0]!.membershipId);
      expect(other?.profile_photo_path).toBe(AVATAR_PATH(members[0]!.user.id));
    });

    it('returns nothing to somebody outside the league, exactly as before', async () => {
      // The authorization predicate was carried over verbatim; this is the
      // assertion that it was.
      expect(await rowsFor(SQL, outsider)).toEqual([]);
    });

    it('returns nothing to a signed-out visitor', async () => {
      const rows = await asAnon(db, async (client) => {
        const result = await client.query(SQL, [match]).catch(() => ({ rows: [] }));
        return result.rows;
      });
      expect(rows).toEqual([]);
    });

    it('returns exactly five columns, and none of them is the legacy url', async () => {
      expect(await columnsFor(SQL, members[1]!.user)).toEqual([
        'first_name',
        'is_self',
        'last_name',
        'membership_id',
        'profile_photo_path',
      ]);
    });

    it('gives null for a member with no photo at all', async () => {
      const rows = await rowsFor<{ membership_id: string; profile_photo_path: string | null }>(
        SQL,
        members[0]!.user,
      );

      const bare = rows.find((row) => row.membership_id === members[1]!.membershipId);
      expect(bare?.profile_photo_path).toBeNull();
    });

    it('gives null for a member whose only photo is a legacy url', async () => {
      await setLegacyUrl(members[2]!.user, LEGACY_URL);

      const rows = await rowsFor<{ membership_id: string; profile_photo_path: string | null }>(
        SQL,
        members[0]!.user,
      );

      // The whole product decision in one assertion: a legacy address does not
      // become visible to other members by way of this feature.
      const legacy = rows.find((row) => row.membership_id === members[2]!.membershipId);
      expect(legacy?.profile_photo_path).toBeNull();
    });

    it('does not carry the legacy url for the caller own row either', async () => {
      // NOT conditional on `is_self`. A member whose only photo is legacy sees
      // initials for themselves on a roster, and one upload fixes it — an
      // invariant with an exception is one somebody eventually gets wrong.
      await setAvatarPath(members[0]!.user, null);
      await setLegacyUrl(members[0]!.user, LEGACY_URL);

      const rows = await rowsFor<{ is_self: boolean; profile_photo_path: string | null }>(
        SQL,
        members[0]!.user,
      );

      const own = rows.find((row) => row.is_self);
      expect(own).toBeDefined();
      expect(own?.profile_photo_path).toBeNull();
      expect(JSON.stringify(rows)).not.toContain('elsewhere.test');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. match_roster_admin — administrator only
  // ══════════════════════════════════════════════════════════════════════════

  describe('match_roster_admin', () => {
    const SQL = 'select * from public.match_roster_admin($1)';

    beforeEach(async () => {
      await joinAll(3);
      await setAvatarPath(members[0]!.user, AVATAR_PATH(members[0]!.user.id));
    });

    it('gives the administrator each player managed avatar path', async () => {
      const rows = await rowsFor<{ membership_id: string; profile_photo_path: string | null }>(
        SQL,
        admin,
      );

      const player = rows.find((row) => row.membership_id === members[0]!.membershipId);
      expect(player?.profile_photo_path).toBe(AVATAR_PATH(members[0]!.user.id));
    });

    it('still returns nothing to a player of the same league', async () => {
      expect(await rowsFor(SQL, members[0]!.user)).toEqual([]);
    });

    it('still returns nothing to another league administrator', async () => {
      expect(await rowsFor(SQL, SEED_USERS.rmvfcAdmin)).toEqual([]);
    });

    it('returns exactly the documented columns, with no phone and no legacy url', async () => {
      expect(await columnsFor(SQL, admin)).toEqual([
        'first_name',
        'gender',
        'goalkeeper_willing',
        'last_name',
        'membership_id',
        'membership_status',
        'override_reason',
        'preferred_positions',
        'priority_qualified',
        'profile_photo_path',
        'responded_at',
        'selected_at',
        'signup_id',
        'status',
        'waitlist_position',
      ]);
    });

    it('keeps gender gated on the league feature flag', async () => {
      await db.pool.query('update public.profiles set gender = $1 where id = $2', [
        'non-binary',
        members[0]!.user.id,
      ]);

      const disabled = await rowsFor<{ gender: string | null }>(SQL, admin);
      expect(disabled.every((row) => row.gender === null)).toBe(true);

      await db.pool.query('update public.leagues set gender_field_enabled = true where id = $1', [
        league,
      ]);
      const enabled = await rowsFor<{ membership_id: string; gender: string | null }>(SQL, admin);
      expect(
        enabled.find((row) => row.membership_id === members[0]!.membershipId)?.gender,
      ).toBe('non-binary');
    });

    it('keeps goalkeeper willingness gated on the league feature flag', async () => {
      await db.pool.query('update public.profiles set goalkeeper_willing = true where id = $1', [
        members[0]!.user.id,
      ]);

      // Weeknight 5v5 seeds `goalkeeper_field_enabled = true` (unlike the gender
      // flag), so the *off* case has to be created rather than assumed. Both
      // directions are asserted, because a gate that never opens and a gate
      // that never closes are equally broken and look identical from one side.
      await db.pool.query(
        'update public.leagues set goalkeeper_field_enabled = false where id = $1',
        [league],
      );
      const disabled = await rowsFor<{ goalkeeper_willing: boolean | null }>(SQL, admin);
      expect(disabled.every((row) => row.goalkeeper_willing === null)).toBe(true);

      await db.pool.query(
        'update public.leagues set goalkeeper_field_enabled = true where id = $1',
        [league],
      );
      const enabled = await rowsFor<{ membership_id: string; goalkeeper_willing: boolean | null }>(
        SQL,
        admin,
      );
      expect(
        enabled.find((row) => row.membership_id === members[0]!.membershipId)?.goalkeeper_willing,
      ).toBe(true);
    });

    it('gives null for a legacy-only photo and never the address itself', async () => {
      await setLegacyUrl(members[1]!.user, LEGACY_URL);

      const rows = await rowsFor<{ membership_id: string; profile_photo_path: string | null }>(
        SQL,
        admin,
      );

      expect(
        rows.find((row) => row.membership_id === members[1]!.membershipId)?.profile_photo_path,
      ).toBeNull();
      expect(JSON.stringify(rows)).not.toContain('elsewhere.test');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. match_team_builder — administrator only
  // ══════════════════════════════════════════════════════════════════════════

  describe('match_team_builder', () => {
    const SQL = 'select * from public.match_team_builder($1)';

    beforeEach(async () => {
      await joinAll(4);
      await setAvatarPath(members[0]!.user, AVATAR_PATH(members[0]!.user.id));
    });

    it('gives the administrator each confirmed player avatar path', async () => {
      const rows = await rowsFor<{ membership_id: string; profile_photo_path: string | null }>(
        SQL,
        admin,
      );

      expect(
        rows.find((row) => row.membership_id === members[0]!.membershipId)?.profile_photo_path,
      ).toBe(AVATAR_PATH(members[0]!.user.id));
    });

    it('still returns nothing to a player', async () => {
      expect(await rowsFor(SQL, members[0]!.user)).toEqual([]);
    });

    it('returns exactly the documented columns', async () => {
      expect(await columnsFor(SQL, admin)).toEqual([
        'display_order',
        'first_name',
        'gender',
        'goalkeeper_willing',
        'last_name',
        'membership_id',
        'preferred_positions',
        'profile_photo_path',
        'team_id',
        'team_name',
      ]);
    });

    it('keeps the feature-flag gating unchanged in both directions', async () => {
      await db.pool.query(
        'update public.profiles set gender = $1, goalkeeper_willing = true where id = $2',
        ['woman', members[0]!.user.id],
      );
      await db.pool.query(
        `update public.leagues
            set gender_field_enabled = false, goalkeeper_field_enabled = false
          where id = $1`,
        [league],
      );

      const off = await rowsFor<{ gender: string | null; goalkeeper_willing: boolean | null }>(
        SQL,
        admin,
      );
      expect(off.every((row) => row.gender === null)).toBe(true);
      expect(off.every((row) => row.goalkeeper_willing === null)).toBe(true);

      await db.pool.query(
        `update public.leagues
            set gender_field_enabled = true, goalkeeper_field_enabled = true
          where id = $1`,
        [league],
      );

      const on = await rowsFor<{
        membership_id: string;
        gender: string | null;
        goalkeeper_willing: boolean | null;
      }>(SQL, admin);
      const player = on.find((row) => row.membership_id === members[0]!.membershipId);
      expect(player?.gender).toBe('woman');
      expect(player?.goalkeeper_willing).toBe(true);
    });

    it('gives null for a legacy-only photo', async () => {
      await setLegacyUrl(members[1]!.user, LEGACY_URL);

      const rows = await rowsFor<{ membership_id: string; profile_photo_path: string | null }>(
        SQL,
        admin,
      );
      expect(
        rows.find((row) => row.membership_id === members[1]!.membershipId)?.profile_photo_path,
      ).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. match_published_teams — confirmed players of that match
  // ══════════════════════════════════════════════════════════════════════════

  describe('match_published_teams', () => {
    const SQL = 'select * from public.match_published_teams($1)';

    beforeEach(async () => {
      await joinAll(4);
      await setAvatarPath(members[0]!.user, AVATAR_PATH(members[0]!.user.id));
      await publishTeams();
    });

    it('gives a confirmed player their teammates avatar paths', async () => {
      const rows = await rowsFor<{ membership_id: string; profile_photo_path: string | null }>(
        SQL,
        members[1]!.user,
      );

      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows.find((row) => row.membership_id === members[0]!.membershipId)?.profile_photo_path,
      ).toBe(AVATAR_PATH(members[0]!.user.id));
    });

    it('still returns nothing to a league member who is not playing', async () => {
      // The strictest reader check in the product: league membership is not
      // enough, the caller must be confirmed for this match.
      const bystander = await createExtraMembers(db, league, 1, 'bystander');
      expect(await rowsFor(SQL, bystander[0]!.user)).toEqual([]);
    });

    it('still returns nothing to somebody outside the league', async () => {
      expect(await rowsFor(SQL, outsider)).toEqual([]);
    });

    it('returns exactly eight columns, with no legacy url', async () => {
      expect(await columnsFor(SQL, members[1]!.user)).toEqual([
        'display_order',
        'first_name',
        'is_self',
        'last_name',
        'membership_id',
        'profile_photo_path',
        'team_label',
        'team_name',
      ]);
    });

    it('gives null for a legacy-only photo, including the caller own row', async () => {
      await setAvatarPath(members[1]!.user, null);
      await setLegacyUrl(members[1]!.user, LEGACY_URL);

      const rows = await rowsFor<{ is_self: boolean; profile_photo_path: string | null }>(
        SQL,
        members[1]!.user,
      );

      expect(rows.find((row) => row.is_self)?.profile_photo_path).toBeNull();
      expect(JSON.stringify(rows)).not.toContain('elsewhere.test');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. match_attendance_workspace — administrator only
  // ══════════════════════════════════════════════════════════════════════════

  describe('match_attendance_workspace', () => {
    const SQL = 'select * from public.match_attendance_workspace($1)';

    beforeEach(async () => {
      await joinAll(3);
      await setAvatarPath(members[0]!.user, AVATAR_PATH(members[0]!.user.id));
      await endMatchAndConfirm();
    });

    it('gives the administrator each player avatar path', async () => {
      const rows = await rowsFor<{ membership_id: string; profile_photo_path: string | null }>(
        SQL,
        admin,
      );

      expect(
        rows.find((row) => row.membership_id === members[0]!.membershipId)?.profile_photo_path,
      ).toBe(AVATAR_PATH(members[0]!.user.id));
    });

    it('still returns nothing to a player, note and all', async () => {
      expect(await rowsFor(SQL, members[0]!.user)).toEqual([]);
    });

    it('still returns nothing to another league administrator', async () => {
      expect(await rowsFor(SQL, SEED_USERS.rmvfcAdmin)).toEqual([]);
    });

    it('returns exactly the documented columns, note included and legacy url not', async () => {
      expect(await columnsFor(SQL, admin)).toEqual([
        'canceled_at',
        'first_name',
        'last_name',
        'membership_id',
        'note',
        'outcome',
        'profile_photo_path',
        'recorded_at',
        'revision',
        'signup_status',
        'suggested',
      ]);
    });

    it('gives null for a legacy-only photo', async () => {
      await setLegacyUrl(members[1]!.user, LEGACY_URL);

      const rows = await rowsFor<{ membership_id: string; profile_photo_path: string | null }>(
        SQL,
        admin,
      );
      expect(
        rows.find((row) => row.membership_id === members[1]!.membershipId)?.profile_photo_path,
      ).toBeNull();
      expect(JSON.stringify(rows)).not.toContain('elsewhere.test');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Across all five: what a recreated function must not have lost
  // ══════════════════════════════════════════════════════════════════════════

  describe('every recreated function kept its security properties', () => {
    const FUNCTIONS = [
      'match_confirmed_roster',
      'match_roster_admin',
      'match_team_builder',
      'match_published_teams',
      'match_attendance_workspace',
    ] as const;

    it('is SECURITY DEFINER, STABLE, and pinned to an empty search_path', async () => {
      const { rows } = await db.pool.query<{
        proname: string;
        prosecdef: boolean;
        volatile: string;
        proconfig: string[] | null;
      }>(
        `select p.proname, p.prosecdef, p.provolatile as volatile, p.proconfig
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = any($1)`,
        [FUNCTIONS],
      );

      expect(rows).toHaveLength(FUNCTIONS.length);
      for (const row of rows) {
        // A dropped-and-recreated function that silently lost `security
        // definer` would return zero rows to everybody; one that lost
        // `search_path = ''` would be vulnerable to a hostile search path in
        // the caller's session.
        expect(row.prosecdef, `${row.proname} security definer`).toBe(true);
        expect(row.volatile, `${row.proname} stable`).toBe('s');
        expect(row.proconfig, `${row.proname} search_path`).toEqual(['search_path=""']);
      }
    });

    it('grants EXECUTE to authenticated and service_role, and to nobody else', async () => {
      const { rows } = await db.pool.query<{ proname: string; grantee: string }>(
        `select p.proname, a.grantee::regrole::text as grantee
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           cross join lateral aclexplode(p.proacl) a
          where n.nspname = 'public' and p.proname = any($1)
            and a.privilege_type = 'EXECUTE'`,
        [FUNCTIONS],
      );

      for (const name of FUNCTIONS) {
        const grantees = rows
          .filter((row) => row.proname === name)
          .map((row) => row.grantee)
          .sort();

        // `postgres` is the owner and is implicit. The point is that `anon` is
        // absent and that the drop/create did not leave PostgreSQL's built-in
        // EXECUTE-to-PUBLIC in place — which is what `-` renders as.
        expect(grantees, name).toEqual(['authenticated', 'postgres', 'service_role']);
        expect(grantees, name).not.toContain('anon');
        expect(grantees, name).not.toContain('-');
      }
    });

    it('is not callable by anon', async () => {
      for (const name of FUNCTIONS) {
        const refused = await asAnon(db, async (client) => {
          try {
            await client.query(`select * from public.${name}($1)`, [match]);
            return false;
          } catch {
            return true;
          }
        });
        expect(refused, name).toBe(true);
      }
    });

    it('exposes profile_photo_path and never profile_photo_url', async () => {
      // The one assertion that covers all five at once, read straight from the
      // catalogue rather than from a query result — so it holds even for a
      // caller who would receive zero rows.
      const { rows } = await db.pool.query<{ proname: string; result: string }>(
        `select p.proname, pg_get_function_result(p.oid) as result
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = any($1)`,
        [FUNCTIONS],
      );

      expect(rows).toHaveLength(FUNCTIONS.length);
      for (const row of rows) {
        expect(row.result, `${row.proname} exposes the path`).toContain('profile_photo_path text');
        expect(row.result, `${row.proname} hides the legacy url`).not.toContain('profile_photo_url');
        expect(row.result, `${row.proname} has no phone`).not.toContain('phone');
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Nothing new was opened up
  // ══════════════════════════════════════════════════════════════════════════

  describe('profiles remain unreadable to other members', () => {
    it('still hides another member profile row from a player', async () => {
      await setAvatarPath(members[0]!.user, AVATAR_PATH(members[0]!.user.id));

      const rows = await rowsFor(
        'select id from public.profiles where id = $1',
        members[1]!.user,
        [members[0]!.user.id],
      );

      // The avatar is visible through a projection, not because `profiles`
      // opened up. This is the assertion that the migration added no policy.
      expect(rows).toEqual([]);
    });

    it('adds no general avatar lookup function', async () => {
      const { rows } = await db.pool.query<{ proname: string }>(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and (p.proname like '%avatar%' or p.proname like '%photo%')`,
      );

      // A `profile_avatar(user_id)` helper would let any authenticated caller
      // resolve an avatar for an arbitrary id — a wider grant than "people
      // whose names you can already see", and one that could not be narrowed
      // later without breaking clients.
      expect(rows).toEqual([]);
    });
  });
});

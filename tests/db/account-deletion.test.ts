import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asServiceRole,
  asUser,
  asUserCommitting,
  createExtraMembers,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_LEAGUES,
  SEED_USERS,
  type ExtraMember,
  type SeedUser,
  type TestDatabase,
} from './helpers/harness';

/**
 * Deleting your own account.
 *
 * ── WHAT THESE TESTS ARE REALLY GUARDING ───────────────────────────────────
 *
 * Two properties, and they pull in opposite directions:
 *
 *   * nothing personal survives — no name, email, phone, photo or free text;
 *   * everything historical survives — the completed match still has the same
 *     number of players on its team sheet and in its register.
 *
 * A change that satisfies one by breaking the other passes a casual review and
 * fails here. So every assertion below is either "this is gone" or "this is
 * exactly as it was", and the two lists are both explicit rather than one being
 * implied by the other.
 */

const LEAGUE = SEED_LEAGUES.weeknightFives;
const OTHER_LEAGUE = SEED_LEAGUES.rmvfc;
const MATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000011';
const ADMIN = SEED_USERS.fivesAdmin;

/** A believable person: profile, membership, history and every transient row. */
const DANA: SeedUser = { id: '99999999-9999-4999-8999-00000000dead', email: 'dana@matchday.test' };
const DANA_MEMBERSHIP = '99999999-9999-4999-8999-00000000beef';
const DANA_AVATAR = `${DANA.id}/11111111-2222-4333-8444-555555555555.jpg`;
const DANA_STALE_AVATAR = `${DANA.id}/66666666-7777-4888-8999-aaaaaaaaaaaa.jpg`;

describe('account deletion', () => {
  let db: TestDatabase;
  let members: ExtraMember[];

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
    await db.pool.query('update public.matches set capacity = 6, min_players = 1 where id = $1', [
      MATCH,
    ]);
    members = await createExtraMembers(db, LEAGUE, 3);

    await db.pool.query(
      `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, now(), now(), now())`,
      [DANA.id, DANA.email],
    );
    await db.pool.query(
      `insert into public.profiles
         (id, first_name, last_name, email_normalized, phone, gender,
          preferred_positions, goalkeeper_willing, profile_photo_path, profile_photo_url)
       values ($1, 'Dana', 'Delete', $2, '+15551234567', 'woman',
               array['midfield'], true, $3, 'https://legacy.test/face.jpg')`,
      [DANA.id, DANA.email, DANA_AVATAR],
    );
    await db.pool.query(
      `insert into public.league_memberships (id, league_id, user_id, role, status)
       values ($1, $2, $3, 'player', 'active')`,
      [DANA_MEMBERSHIP, LEAGUE, DANA.id],
    );
    // Weeknight 5v5's published guideline is informational, so
    // `current_required_guideline_version` is null for it and the usual
    // fixture helper would insert nothing. Accepting the published version
    // directly is what makes "acceptances survive deletion" testable at all.
    await db.pool.query(
      `insert into public.guideline_acceptances (league_id, membership_id, guideline_version_id)
       select $1, $2, v.id from public.guideline_versions v
        where v.league_id = $1 and v.published_at is not null
        limit 1
       on conflict do nothing`,
      [LEAGUE, DANA_MEMBERSHIP],
    );
    // Two objects: the one the profile names, and a stale one left behind by an
    // earlier upload whose cleanup was swallowed. Deleting only the named path
    // would leave the second publicly fetchable for ever.
    await db.pool.query(
      `insert into storage.objects (bucket_id, name, owner)
       values ('avatars', $1, $2::uuid), ('avatars', $3, $2::uuid)`,
      [DANA_AVATAR, DANA.id, DANA_STALE_AVATAR],
    );
  });

  afterEach(async () => {
    await db.drop();
  });

  async function callAs<T extends Record<string, unknown>>(
    user: SeedUser,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return asUserCommitting(db, user, async (client) => {
      const result = await client.query<T>(sql, params);
      return result.rows;
    });
  }

  const begin = async (user: SeedUser = DANA) =>
    callAs(user, 'select public.begin_my_account_deletion() as started');

  const finalize = async (user: SeedUser = DANA) =>
    callAs(user, 'select public.finalize_my_account_deletion() as finished');

  async function deleteAccount(user: SeedUser = DANA) {
    await begin(user);
    await finalize(user);
  }

  async function profile(id: string = DANA.id) {
    const { rows } = await db.pool.query<{
      first_name: string;
      last_name: string;
      email_normalized: string;
      phone: string | null;
      gender: string | null;
      preferred_positions: string[];
      goalkeeper_willing: boolean | null;
      profile_photo_url: string | null;
      profile_photo_path: string | null;
      created_at: string;
      started: boolean;
      deleted: boolean;
    }>(
      `select first_name, last_name, email_normalized, phone, gender, preferred_positions,
              goalkeeper_willing, profile_photo_url, profile_photo_path, created_at::text,
              deletion_started_at is not null as started, deleted_at is not null as deleted
         from public.profiles where id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await db.pool.query<{ n: string }>(sql, params);
    return Number(rows[0]!.n);
  }

  // ══ D1: the profile outlives the Auth user ═══════════════════════════════

  describe('the identity model', () => {
    it('still equals auth.uid() for a live account', async () => {
      const rows = await asUser(db, DANA, async (client) =>
        (await client.query<{ same: boolean }>(
          'select (select id from public.profiles where id = auth.uid()) = auth.uid() as same',
        )).rows,
      );
      expect(rows[0]!.same).toBe(true);
    });

    it('lets the profile survive deletion of the auth user', async () => {
      // THE WHOLE POINT OF DROPPING THE FOREIGN KEY. Before it, this cascaded
      // and took every membership, signup, attendance record and team-sheet
      // entry with it.
      await db.pool.query('delete from auth.users where id = $1', [DANA.id]);

      expect(await count('select count(*)::text as n from public.profiles where id = $1', [DANA.id])).toBe(1);
      expect(
        await count('select count(*)::text as n from public.league_memberships where user_id = $1', [
          DANA.id,
        ]),
      ).toBe(1);
    });

    it('frees the original email address for a brand-new account', async () => {
      await deleteAccount();

      // Step five of the real flow, which no database function performs: the
      // application calls the Auth Admin API. Without it `auth.users` still
      // holds the address and this would prove nothing about the tombstone.
      await db.pool.query('delete from auth.users where id = $1', [DANA.id]);

      // A different uuid, as GoTrue would mint. The unique index on
      // profiles.email_normalized is what would refuse this if the tombstone
      // had kept the address — which is why the synthetic one uses `.invalid`.
      const fresh = '99999999-9999-4999-8999-00000000f00d';
      await db.pool.query(
        `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
         values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, now(), now(), now())`,
        [fresh, DANA.email],
      );
      await db.pool.query(
        `insert into public.profiles (id, first_name, last_name, email_normalized)
         values ($1, 'Dana', 'Delete', $2)`,
        [fresh, DANA.email],
      );

      expect(await count('select count(*)::text as n from public.profiles where email_normalized = $1', [DANA.email])).toBe(1);
    });

    it('reconnects no history to the new account', async () => {
      await deleteAccount();
      await db.pool.query('delete from auth.users where id = $1', [DANA.id]);
      const fresh = '99999999-9999-4999-8999-00000000f00d';
      await db.pool.query(
        `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
         values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, now(), now(), now())`,
        [fresh, DANA.email],
      );
      await db.pool.query(
        `insert into public.profiles (id, first_name, last_name, email_normalized)
         values ($1, 'Dana', 'Delete', $2)`,
        [fresh, DANA.email],
      );

      expect(
        await count('select count(*)::text as n from public.league_memberships where user_id = $1', [
          fresh,
        ]),
      ).toBe(0);
      // And the old rows still point at the tombstone, not at nothing.
      expect(
        await count('select count(*)::text as n from public.league_memberships where user_id = $1', [
          DANA.id,
        ]),
      ).toBe(1);
    });
  });

  // ══ The deletion state columns ═══════════════════════════════════════════

  describe('the deletion state', () => {
    it('cannot be started by a direct profile update', async () => {
      const error = await expectDatabaseError(() =>
        asUserCommitting(db, DANA, (client) =>
          client.query('update public.profiles set deletion_started_at = now() where id = $1', [
            DANA.id,
          ]),
        ),
      );
      expect(error.message).toContain('NOT_AUTHORIZED');
      expect((await profile())!.started).toBe(false);
    });

    it('cannot be finished by a direct profile update', async () => {
      const error = await expectDatabaseError(() =>
        asUserCommitting(db, DANA, (client) =>
          client.query('update public.profiles set deleted_at = now() where id = $1', [DANA.id]),
        ),
      );
      expect(error.message).toContain('NOT_AUTHORIZED');
    });

    it('cannot be cleared once the workflow has set it', async () => {
      await begin();

      // TWO INDEPENDENT DEFENCES, AND THE OUTER ONE FIRES FIRST. Once deletion
      // has begun, `profiles_update_self` no longer matches the row at all, so
      // the statement updates nothing and raises nothing — RLS filtering, not
      // an error. The guard trigger is the second line, proved by the live-user
      // case above where the policy does match. The assertion here is therefore
      // about the data, which is the property that actually matters.
      await asUserCommitting(db, DANA, (client) =>
        client.query('update public.profiles set deletion_started_at = null where id = $1', [
          DANA.id,
        ]),
      );

      expect((await profile())!.started).toBe(true);
    });

    it('cannot be smuggled in on a new profile row', async () => {
      const stranger = SEED_USERS.outsider;
      const error = await expectDatabaseError(() =>
        asUserCommitting(db, stranger, (client) =>
          client.query(
            `insert into public.profiles (id, first_name, last_name, email_normalized, deleted_at)
             values ($1, 'X', 'Y', $2, now())`,
            [stranger.id, stranger.email],
          ),
        ),
      );
      expect(error.message).toContain('NOT_AUTHORIZED');
    });

    it('refuses a tombstone that was never started', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query('update public.profiles set deleted_at = now() where id = $1', [DANA.id]),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
    });
  });

  // ══ The identity trigger, which would otherwise undo the scrub ═══════════

  describe('profiles_sync_identity', () => {
    it('still forces the session email onto a live profile', async () => {
      await asUserCommitting(db, DANA, (client) =>
        client.query(`update public.profiles set first_name = 'Danielle' where id = $1`, [DANA.id]),
      );
      expect((await profile())!.email_normalized).toBe(DANA.email);
    });

    it('does not restore the real email once deletion has started', async () => {
      // THE REGRESSION THIS FILE EXISTS FOR. The trigger forces
      // `email_normalized` to the JWT claim whenever auth.uid() = the row's id,
      // and the deletion RPC runs while the account holder is still signed in.
      // Unamended, it silently writes the real address back over the synthetic
      // one — and every other scrubbed column would still look correct.
      await deleteAccount();

      const row = (await profile())!;
      expect(row.email_normalized).not.toBe(DANA.email);
      expect(row.email_normalized).toBe(`deleted-${DANA.id}@deleted.invalid`);
    });
  });

  // ══ is_live_profile, and everything it gates ═════════════════════════════

  describe('a deletion-pending account', () => {
    beforeEach(async () => {
      await begin();
    });

    it('is not a live profile', async () => {
      const rows = await asUser(db, DANA, async (client) =>
        (await client.query<{ live: boolean }>('select public.is_live_profile() as live')).rows,
      );
      expect(rows[0]!.live).toBe(false);
    });

    it('is still distinguishable from having no profile at all', async () => {
      // The distinction the routing depends on: a departing account can read
      // its own row, so the application can send it to the deletion-status
      // screen rather than to onboarding.
      const rows = await asUser(db, DANA, async (client) =>
        (await client.query<{ n: string }>('select count(*)::text as n from public.profiles where id = auth.uid()')).rows,
      );
      expect(Number(rows[0]!.n)).toBe(1);

      const started = await asUser(db, DANA, async (client) =>
        (await client.query<{ v: boolean }>('select public.profile_deletion_started() as v')).rows,
      );
      expect(started[0]!.v).toBe(true);
    });

    it('cannot create a league', async () => {
      // The resurrection path: creating a league makes you its administrator,
      // which would give a tombstoned account a live membership again.
      const error = await expectDatabaseError(() =>
        callAs(
          DANA,
          `select public.create_league('New', 'brand-new-league', 'Area', 'UTC', 'Soccer', 'Desc', 10)`,
        ),
      );
      expect(error.message).toContain('ACCOUNT_DELETION_IN_PROGRESS');
    });

    it('cannot request to join a league', async () => {
      // Searchable, or the request is refused as LEAGUE_NOT_FOUND before it
      // ever reaches the guard — which would make this test pass for the wrong
      // reason.
      await db.pool.query(
        `update public.leagues set visibility = 'searchable' where id = $1`,
        [OTHER_LEAGUE],
      );

      const error = await expectDatabaseError(() =>
        callAs(DANA, 'select public.request_to_join_league($1)', [OTHER_LEAGUE]),
      );
      expect(error.message).toContain('ACCOUNT_DELETION_IN_PROGRESS');
    });

    it('cannot be added to a league by an administrator either', async () => {
      // NOT A CALL THE DEPARTING USER MAKES AT ALL, which is exactly why the
      // guard asks about the row's subject rather than about who is acting. An
      // administrator adding, approving or reinstating somebody mid-deletion
      // would otherwise hand a tombstone a live membership.
      const error = await expectDatabaseError(() =>
        callAs(SEED_USERS.rmvfcAdmin, 'select public.add_league_member_by_email($1, $2)', [
          OTHER_LEAGUE,
          DANA.email,
        ]),
      );
      expect(error.message).toContain('ACCOUNT_DELETION_IN_PROGRESS');
    });

    it('cannot join a match', async () => {
      const error = await expectDatabaseError(() =>
        callAs(DANA, 'select public.join_match($1)', [MATCH]),
      );
      expect(error.message).toContain('MEMBERSHIP_REQUIRED');
    });

    it('cannot register a push subscription', async () => {
      const error = await expectDatabaseError(() =>
        callAs(DANA, 'select public.register_push_subscription($1, $2, $3)', [
          'https://fcm.googleapis.com/fcm/send/new-device-0001',
          'B'.repeat(87),
          'C'.repeat(22),
        ]),
      );
      expect(error.message).toContain('ACCOUNT_DELETION_IN_PROGRESS');
    });

    it('cannot mutate a notification', async () => {
      const { rows } = await db.pool.query<{ id: string }>(
        `insert into public.notifications
           (recipient_user_id, league_id, type, title, body, deep_link, idempotency_key)
         values ($1, $2, 'match_published', 'M', 'b', '/dashboard', 'dana-notif-0001')
         returning id`,
        [DANA.id, LEAGUE],
      );

      const error = await expectDatabaseError(() =>
        callAs(DANA, 'select public.mark_notification_read($1)', [rows[0]!.id]),
      );
      expect(error.message).toContain('ACCOUNT_DELETION_IN_PROGRESS');
    });

    it('cannot change its own profile', async () => {
      // Silently, by the policy matching no rows — which is what an RLS USING
      // clause does. The assertion is therefore about the data, not an error.
      await asUserCommitting(db, DANA, (client) =>
        client.query(`update public.profiles set first_name = 'Hax' where id = $1`, [DANA.id]),
      );
      expect((await profile())!.first_name).toBe('Dana');
    });

    it('cannot change its active league', async () => {
      await db.pool.query(
        `insert into public.user_app_state (user_id, active_league_id) values ($1, $2)
           on conflict (user_id) do update set active_league_id = excluded.active_league_id`,
        [DANA.id, LEAGUE],
      );

      await asUserCommitting(db, DANA, (client) =>
        client.query('update public.user_app_state set active_league_id = null where user_id = $1', [
          DANA.id,
        ]),
      );

      const { rows } = await db.pool.query<{ active_league_id: string | null }>(
        'select active_league_id from public.user_app_state where user_id = $1',
        [DANA.id],
      );
      expect(rows[0]!.active_league_id).toBe(LEAGUE);
    });

    it('cannot upload a new avatar', async () => {
      // The property that makes Storage cleanup terminate: no new object can
      // appear between enumerating the folder and emptying it.
      await asUserCommitting(db, DANA, (client) =>
        client.query(
          `insert into storage.objects (bucket_id, name, owner)
           values ('avatars', $1 || '/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg', $1::uuid)`,
          [DANA.id],
        ),
      ).catch(() => undefined);

      expect(
        await count(`select count(*)::text as n from storage.objects where bucket_id = 'avatars' and owner = $1`, [
          DANA.id,
        ]),
      ).toBe(2);
    });

    it('can still see its own avatar objects, so cleanup can delete them', async () => {
      // The deliberate asymmetry. Gating SELECT or DELETE on liveness would
      // make the deletion workflow unable to empty the folder it is deleting.
      const rows = await asUser(db, DANA, async (client) =>
        (await client.query<{ name: string }>(
          `select name from storage.objects where bucket_id = 'avatars'`,
        )).rows,
      );
      expect(rows).toHaveLength(2);
    });
  });

  // ══ Authorization of the RPCs themselves ═════════════════════════════════

  describe('who may call the deletion functions', () => {
    it('refuses an anonymous caller at the grant', async () => {
      const error = await expectDatabaseError(() =>
        asAnon(db, (client) => client.query('select public.begin_my_account_deletion()')),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('takes no user id at all', async () => {
      const { rows } = await db.pool.query<{ name: string; args: string }>(
        `select p.proname as name, pg_get_function_arguments(p.oid) as args
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('begin_my_account_deletion', 'finalize_my_account_deletion')
          order by p.proname`,
      );
      expect(rows.map((row) => row.args)).toEqual(['', '']);
    });

    it('does not let one user finalize another', async () => {
      await begin();

      const error = await expectDatabaseError(() =>
        callAs(members[0]!.user, 'select public.finalize_account_deletion($1)', [DANA.id]),
      );
      // `authenticated` holds no EXECUTE on the service-role variant.
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('refuses to finalize a live account even with the service role', async () => {
      // The line that makes it safe to hand this capability to a cron job.
      const error = await expectDatabaseError(() =>
        asServiceRole(db, (client) =>
          client.query('select public.finalize_account_deletion($1)', [members[0]!.user.id]),
        ),
      );
      expect(error.message).toContain('NOT_AUTHORIZED');
    });

    it('is SECURITY DEFINER with an empty search_path and no PUBLIC execute', async () => {
      const { rows } = await db.pool.query<{
        proname: string;
        prosecdef: boolean;
        proconfig: string[] | null;
        proacl: string | null;
      }>(
        `select p.proname, p.prosecdef, p.proconfig, p.proacl::text
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('is_live_profile', 'profile_deletion_started',
                              'begin_my_account_deletion', 'finalize_my_account_deletion',
                              'finalize_account_deletion', 'accounts_awaiting_deletion',
                              'my_account_deletion_blockers', 'close_league')`,
      );
      expect(rows).toHaveLength(8);
      for (const row of rows) {
        expect(row.prosecdef, `${row.proname} is not SECURITY DEFINER`).toBe(true);
        expect(row.proconfig, `${row.proname} has no pinned search_path`).toContain('search_path=""');
        expect(row.proacl, `${row.proname} has no ACL`).not.toBeNull();
        expect(row.proacl!, `${row.proname} is executable by PUBLIC`).not.toMatch(/[{,]=[^/]*X/);
      }
    });

    it('keeps the reconciler entry points off the authenticated role', async () => {
      for (const signature of [
        'public.finalize_account_deletion(uuid)',
        'public.accounts_awaiting_deletion(integer)',
      ]) {
        const { rows } = await db.pool.query<{ ok: boolean }>(
          `select has_function_privilege('authenticated', $1, 'execute') as ok`,
          [signature],
        );
        expect(rows[0]!.ok, `${signature} is reachable by a session`).toBe(false);
      }
    });
  });

  // ══ The tombstone contract, column by column ═════════════════════════════

  describe('the tombstone', () => {
    it('matches the agreed contract exactly', async () => {
      const before = (await profile())!;
      await deleteAccount();
      const after = (await profile())!;

      expect(after).toMatchObject({
        first_name: 'Former',
        last_name: 'member',
        email_normalized: `deleted-${DANA.id}@deleted.invalid`,
        phone: null,
        gender: null,
        preferred_positions: [],
        goalkeeper_willing: null,
        profile_photo_url: null,
        profile_photo_path: null,
        started: true,
        deleted: true,
      });
      // Unchanged, and deliberately so: an account-creation date identifies
      // nobody and ordering depends on it.
      expect(after.created_at).toBe(before.created_at);
    });

    it('leaves nothing recoverable of the original identity', async () => {
      await deleteAccount();

      const { rows } = await db.pool.query<{ blob: string }>(
        `select coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' '
                || coalesce(email_normalized, '') || ' ' || coalesce(phone, '') || ' '
                || coalesce(gender, '') || ' ' || coalesce(profile_photo_url, '') || ' '
                || coalesce(profile_photo_path, '') as blob
           from public.profiles where id = $1`,
        [DANA.id],
      );
      for (const secret of ['Dana', 'Delete', 'dana@matchday.test', '15551234567', 'woman', 'legacy.test']) {
        expect(rows[0]!.blob, `the tombstone still contains ${secret}`).not.toContain(secret);
      }
    });

    it('uses an address that is not derived from the original', async () => {
      await deleteAccount();
      const synthetic = (await profile())!.email_normalized;

      // Not a hash or an encoding: it is the profile id, a value that existed
      // before the address was ever known. `.invalid` is RFC 2606 reserved, so
      // it can never collide with a real domain.
      expect(synthetic).toBe(`deleted-${DANA.id}@deleted.invalid`);
      expect(synthetic).toContain('@deleted.invalid');
      expect(synthetic).not.toContain('dana');
    });
  });

  // ══ What is deleted, and what is kept ════════════════════════════════════

  describe('the delete/preserve matrix', () => {
    beforeEach(async () => {
      // History worth keeping: a completed match with a published team sheet
      // and a recorded attendance.
      await callAs(DANA, 'select public.join_match($1)', [MATCH]);
      await callAs(members[0]!.user, 'select public.join_match($1)', [MATCH]);
      await callAs(ADMIN, 'select public.finalize_roster($1)', [MATCH]);
      await callAs(ADMIN, 'select public.ensure_match_teams($1)', [MATCH]);
      await callAs(ADMIN, 'select public.randomize_match_teams($1)', [MATCH]);
      await callAs(ADMIN, 'select public.publish_match_teams($1)', [MATCH]);
      await db.pool.query(
        `update public.matches
            set match_date = (now() - interval '2 days')::date,
                arrival_at = now() - interval '2 days',
                kickoff_at = now() - interval '2 days' + interval '30 minutes',
                end_at = now() - interval '2 days' + interval '2 hours',
                signup_closes_at = now() - interval '2 days',
                cancellation_cutoff_at = now() - interval '3 days'
          where id = $1`,
        [MATCH],
      );
      await callAs(ADMIN, `select public.record_attendance($1, $2, 'attended')`, [
        MATCH,
        DANA_MEMBERSHIP,
      ]);

      // Transient personal rows.
      await db.pool.query(
        `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth_secret)
         values ($1, 'https://fcm.googleapis.com/fcm/send/dana-0001', $2, $3)`,
        [DANA.id, 'B'.repeat(87), 'C'.repeat(22)],
      );
      await db.pool.query(
        `insert into public.user_app_state (user_id, active_league_id) values ($1, $2)
           on conflict (user_id) do update set active_league_id = excluded.active_league_id`,
        [DANA.id, LEAGUE],
      );
      await db.pool.query(
        `insert into public.league_join_requests (league_id, user_id, status, message)
         values ($1, $2, 'pending', 'Dana here, 07700 900123')`,
        [OTHER_LEAGUE, DANA.id],
      );
      await db.pool.query(
        `insert into public.league_membership_admin_notes (league_id, membership_id, note, created_by)
         values ($1, $2, 'Reliable left back', $3)`,
        [LEAGUE, DANA_MEMBERSHIP, ADMIN.id],
      );
      await db.pool.query(
        `insert into public.notifications
           (recipient_user_id, league_id, type, title, body, deep_link, idempotency_key)
         values ($1, $2, 'match_published', 'New match', 'Thursday', '/dashboard', 'dana-own-0001')`,
        [DANA.id, LEAGUE],
      );
      // The one notification in the product that names a person in its body.
      await db.pool.query(
        `insert into public.notifications
           (recipient_user_id, league_id, type, title, body, deep_link, idempotency_key)
         values ($1, $2, 'member_left', 'A member left', 'Dana Delete left Weeknight 5v5.',
                 '/leagues/weeknight-5v5/members', 'dana-admin-0001')`,
        [ADMIN.id, LEAGUE],
      );
    });

    it('keeps the historical signup', async () => {
      const before = await count(
        'select count(*)::text as n from public.match_signups where membership_id = $1',
        [DANA_MEMBERSHIP],
      );
      await deleteAccount();
      expect(
        await count('select count(*)::text as n from public.match_signups where membership_id = $1', [
          DANA_MEMBERSHIP,
        ]),
      ).toBe(before);
    });

    it('keeps the completed match at its original size', async () => {
      const before = await count(
        'select count(*)::text as n from public.match_signups where match_id = $1',
        [MATCH],
      );
      await deleteAccount();

      // THE PROPERTY THE WHOLE TOMBSTONE ARCHITECTURE EXISTS FOR. Measured
      // against the old cascade this went 2 -> 1 with no marker.
      expect(await count('select count(*)::text as n from public.match_signups where match_id = $1', [MATCH])).toBe(before);
    });

    it('keeps the attendance record and its outcome', async () => {
      await deleteAccount();

      const { rows } = await db.pool.query<{ outcome: string }>(
        'select outcome::text from public.attendance_records where membership_id = $1',
        [DANA_MEMBERSHIP],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outcome).toBe('attended');
    });

    it('keeps the published team-sheet entry of a match that was played', async () => {
      const before = await count(
        `select count(*)::text as n from public.match_team_publication_entries
          where membership_id = $1`,
        [DANA_MEMBERSHIP],
      );
      expect(before).toBeGreaterThan(0);

      await deleteAccount();

      expect(
        await count(
          `select count(*)::text as n from public.match_team_publication_entries
            where membership_id = $1`,
          [DANA_MEMBERSHIP],
        ),
      ).toBe(before);
    });

    it('keeps the guideline acceptance', async () => {
      const before = await count(
        'select count(*)::text as n from public.guideline_acceptances where membership_id = $1',
        [DANA_MEMBERSHIP],
      );
      expect(before).toBeGreaterThan(0);
      await deleteAccount();
      expect(
        await count(
          'select count(*)::text as n from public.guideline_acceptances where membership_id = $1',
          [DANA_MEMBERSHIP],
        ),
      ).toBe(before);
    });

    it('keeps the audit trail', async () => {
      const before = await count(
        'select count(*)::text as n from public.audit_events where entity_id = $1',
        [DANA_MEMBERSHIP],
      );
      await deleteAccount();
      expect(
        await count('select count(*)::text as n from public.audit_events where entity_id = $1', [
          DANA_MEMBERSHIP,
        ]),
      ).toBeGreaterThanOrEqual(before);
    });

    it('keeps the membership row, marked removed with no reason left on it', async () => {
      await deleteAccount();

      const { rows } = await db.pool.query<{ status: string; status_reason: string | null }>(
        'select status::text, status_reason from public.league_memberships where id = $1',
        [DANA_MEMBERSHIP],
      );
      expect(rows[0]!.status).toBe('removed');
      // Administrator free text attached to this person's identity. Scrubbed
      // for the same reason the profile is.
      expect(rows[0]!.status_reason).toBeNull();
    });

    it('deletes the administrator notes written about them', async () => {
      await deleteAccount();
      expect(
        await count(
          'select count(*)::text as n from public.league_membership_admin_notes where membership_id = $1',
          [DANA_MEMBERSHIP],
        ),
      ).toBe(0);
    });

    it('deletes push subscriptions and their delivery attempts', async () => {
      await deleteAccount();
      expect(
        await count('select count(*)::text as n from public.push_subscriptions where user_id = $1', [
          DANA.id,
        ]),
      ).toBe(0);
      expect(
        await count(
          `select count(*)::text as n from public.push_delivery_attempts a
             join public.push_subscriptions s on s.id = a.subscription_id
            where s.user_id = $1`,
          [DANA.id],
        ),
      ).toBe(0);
    });

    it('deletes the app state, join requests and own notifications', async () => {
      await deleteAccount();
      expect(await count('select count(*)::text as n from public.user_app_state where user_id = $1', [DANA.id])).toBe(0);
      expect(await count('select count(*)::text as n from public.league_join_requests where user_id = $1', [DANA.id])).toBe(0);
      expect(await count('select count(*)::text as n from public.notifications where recipient_user_id = $1', [DANA.id])).toBe(0);
    });

    it('rewrites the administrator notification that named them', async () => {
      await deleteAccount();

      const { rows } = await db.pool.query<{ body: string; recipient_user_id: string }>(
        `select body, recipient_user_id from public.notifications where type = 'member_left'`,
      );
      // The record stays — it is operational history the administrator relies
      // on — and the name goes.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.recipient_user_id).toBe(ADMIN.id);
      expect(rows[0]!.body).toBe('A member left Weeknight 5v5.');
      expect(rows[0]!.body).not.toContain('Dana');
    });

    it('leaves no trace of the name anywhere a notification can be read', async () => {
      await deleteAccount();

      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.notifications
          where title like '%Dana%' or body like '%Dana%'`,
      );
      expect(rows[0]!.n).toBe('0');
    });
  });

  // ══ Future matches ═══════════════════════════════════════════════════════

  describe('future matches', () => {
    it('releases the place and promotes from the waitlist', async () => {
      await db.pool.query(
        `update public.matches set capacity = 2, waitlist_mode = 'automatic' where id = $1`,
        [MATCH],
      );
      await callAs(DANA, 'select public.join_match($1)', [MATCH]);
      await callAs(members[0]!.user, 'select public.join_match($1)', [MATCH]);
      await callAs(members[1]!.user, 'select public.join_match($1)', [MATCH]);

      await deleteAccount();

      const { rows } = await db.pool.query<{ status: string }>(
        'select status::text from public.match_signups where match_id = $1 and membership_id = $2',
        [MATCH, DANA_MEMBERSHIP],
      );
      expect(rows[0]!.status).toBe('not_selected');

      const promoted = await db.pool.query<{ status: string }>(
        'select status::text from public.match_signups where match_id = $1 and membership_id = $2',
        [MATCH, members[1]!.membershipId],
      );
      expect(promoted.rows[0]!.status).toBe('confirmed');
    });

    it('leaves a match that has already kicked off alone', async () => {
      await callAs(DANA, 'select public.join_match($1)', [MATCH]);
      await db.pool.query(
        `update public.matches
            set match_date = (now() - interval '2 hours')::date,
                arrival_at = now() - interval '3 hours',
                kickoff_at = now() - interval '2 hours',
                end_at = now() - interval '30 minutes',
                signup_closes_at = now() - interval '2 hours',
                cancellation_cutoff_at = now() - interval '2 hours'
          where id = $1`,
        [MATCH],
      );

      await deleteAccount();

      const { rows } = await db.pool.query<{ status: string }>(
        'select status::text from public.match_signups where match_id = $1 and membership_id = $2',
        [MATCH, DANA_MEMBERSHIP],
      );
      expect(rows[0]!.status).toBe('confirmed');
    });
  });

  // ══ Idempotency ══════════════════════════════════════════════════════════

  describe('running it more than once', () => {
    it('returns the original start time rather than a new one', async () => {
      const first = await callAs<{ started: string }>(
        DANA,
        'select public.begin_my_account_deletion() as started',
      );
      const second = await callAs<{ started: string }>(
        DANA,
        'select public.begin_my_account_deletion() as started',
      );
      expect(second[0]!.started).toEqual(first[0]!.started);
    });

    it('finalizes twice without changing anything', async () => {
      await deleteAccount();
      const after = (await profile())!;

      await finalize();

      expect(await profile()).toEqual(after);
    });

    it('refuses to finalize before the deletion has begun', async () => {
      const error = await expectDatabaseError(() => finalize());
      expect(error.message).toContain('NOT_AUTHORIZED');
    });
  });

  // ══ Reconciliation ═══════════════════════════════════════════════════════

  describe('accounts_awaiting_deletion', () => {
    it('lists an account whose scrub has not run', async () => {
      await begin();

      const rows = await asServiceRole(db, async (client) =>
        (await client.query<{ profile_id: string; auth_user_exists: boolean; deleted_at: string | null }>(
          'select profile_id, auth_user_exists, deleted_at from public.accounts_awaiting_deletion(50)',
        )).rows,
      );
      expect(rows.map((row) => row.profile_id)).toContain(DANA.id);
      expect(rows.find((row) => row.profile_id === DANA.id)!.deleted_at).toBeNull();
    });

    it('still lists a scrubbed account while the Auth row survives', async () => {
      // THE STATE THAT LOOKS FINISHED AND IS NOT. Postgres is anonymous;
      // auth.users still holds the real address.
      await deleteAccount();

      const rows = await asServiceRole(db, async (client) =>
        (await client.query<{ profile_id: string; auth_user_exists: boolean }>(
          'select profile_id, auth_user_exists from public.accounts_awaiting_deletion(50)',
        )).rows,
      );
      const dana = rows.find((row) => row.profile_id === DANA.id);
      expect(dana).toBeDefined();
      expect(dana!.auth_user_exists).toBe(true);
    });

    it('drops the account once both halves are done', async () => {
      await deleteAccount();
      await db.pool.query('delete from auth.users where id = $1', [DANA.id]);

      const rows = await asServiceRole(db, async (client) =>
        (await client.query<{ profile_id: string }>(
          'select profile_id from public.accounts_awaiting_deletion(50)',
        )).rows,
      );
      expect(rows.map((row) => row.profile_id)).not.toContain(DANA.id);
    });

    it('never lists a live account', async () => {
      const rows = await asServiceRole(db, async (client) =>
        (await client.query<{ profile_id: string }>(
          'select profile_id from public.accounts_awaiting_deletion(50)',
        )).rows,
      );
      expect(rows).toHaveLength(0);
    });

    it('is not reachable from a session', async () => {
      const error = await expectDatabaseError(() =>
        callAs(DANA, 'select * from public.accounts_awaiting_deletion(50)'),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });

  // ══ Blockers ═════════════════════════════════════════════════════════════

  describe('administered leagues', () => {
    it('reports none for an ordinary player', async () => {
      const rows = await callAs(DANA, 'select * from public.my_account_deletion_blockers()');
      expect(rows).toHaveLength(0);
    });

    it('reports the open league an administrator runs', async () => {
      const rows = await callAs<{
        league_id: string;
        league_name: string;
        has_transfer_target: boolean;
      }>(ADMIN, 'select * from public.my_account_deletion_blockers()');

      expect(rows).toHaveLength(1);
      expect(rows[0]!.league_id).toBe(LEAGUE);
      // There are active players in the seeded league, so transfer is possible.
      expect(rows[0]!.has_transfer_target).toBe(true);
    });

    it('refuses to begin while an open league is administered', async () => {
      const error = await expectDatabaseError(() => begin(ADMIN));
      expect(error.message).toContain('ADMIN_TRANSFER_INVALID');
      expect((await profile(ADMIN.id))!.started).toBe(false);
    });

    it('says so when there is nobody to transfer to', async () => {
      await db.pool.query(
        `update public.league_memberships set status = 'removed'
          where league_id = $1 and role = 'player'`,
        [LEAGUE],
      );

      const rows = await callAs<{ has_transfer_target: boolean }>(
        ADMIN,
        'select * from public.my_account_deletion_blockers()',
      );
      expect(rows[0]!.has_transfer_target).toBe(false);
    });
  });
  // ══ What everybody else sees ═════════════════════════════════════════════

  describe('the projections other members read', () => {
    beforeEach(async () => {
      await callAs(DANA, 'select public.join_match($1)', [MATCH]);
      await callAs(members[0]!.user, 'select public.join_match($1)', [MATCH]);
      await callAs(ADMIN, 'select public.finalize_roster($1)', [MATCH]);
      await callAs(ADMIN, 'select public.ensure_match_teams($1)', [MATCH]);
      await callAs(ADMIN, 'select public.randomize_match_teams($1)', [MATCH]);
      await callAs(ADMIN, 'select public.publish_match_teams($1)', [MATCH]);
    });

    /** A completed match, so history rather than scheduling is under test. */
    async function playTheMatch() {
      await db.pool.query(
        `update public.matches
            set match_date = (now() - interval '2 days')::date,
                arrival_at = now() - interval '2 days',
                kickoff_at = now() - interval '2 days' + interval '30 minutes',
                end_at = now() - interval '2 days' + interval '2 hours',
                signup_closes_at = now() - interval '2 days',
                cancellation_cutoff_at = now() - interval '3 days'
          where id = $1`,
        [MATCH],
      );
    }

    it('shows Former member as soon as deletion begins, before any scrub', async () => {
      // THE WINDOW THAT MATTERS. The profile still holds the real name at this
      // point — the scrub has not run — so masking has to come from the
      // projection, not from the stored row.
      await begin();

      const rows = await callAs<{
        first_name: string;
        last_name: string;
        profile_photo_path: string | null;
        is_former_member: boolean;
      }>(ADMIN, 'select first_name, last_name, profile_photo_path, is_former_member from public.match_roster_admin($1)', [
        MATCH,
      ]);

      const dana = rows.find((row) => row.is_former_member);
      expect(dana).toBeDefined();
      expect(dana!.first_name).toBe('Former');
      expect(dana!.last_name).toBe('member');
      expect(dana!.profile_photo_path).toBeNull();

      // And the profile itself still has the real name, which is what proves
      // the masking is the projection's doing.
      expect((await profile())!.first_name).toBe('Dana');
    });

    it('keeps the completed team sheet the same size, with the player masked', async () => {
      await playTheMatch();
      const before = await callAs<{ membership_id: string }>(
        members[0]!.user,
        'select membership_id from public.match_published_teams($1)',
        [MATCH],
      );
      expect(before).toHaveLength(2);

      await deleteAccount();

      const after = await callAs<{
        membership_id: string;
        first_name: string;
        last_name: string;
        profile_photo_path: string | null;
        is_former_member: boolean;
      }>(
        members[0]!.user,
        'select membership_id, first_name, last_name, profile_photo_path, is_former_member from public.match_published_teams($1)',
        [MATCH],
      );

      // THE HEADLINE PROPERTY: two players before, two after. Under the old
      // cascade this went 2 -> 1 with nothing to show anything had changed.
      expect(after).toHaveLength(2);

      const dana = after.find((row) => row.membership_id === DANA_MEMBERSHIP)!;
      expect(dana.is_former_member).toBe(true);
      expect(dana.first_name).toBe('Former');
      expect(dana.profile_photo_path).toBeNull();

      const other = after.find((row) => row.membership_id === members[0]!.membershipId)!;
      expect(other.is_former_member).toBe(false);
    });

    it('keeps the attendance register intact and masked', async () => {
      await playTheMatch();
      await deleteAccount();

      const rows = await callAs<{
        membership_id: string;
        first_name: string;
        is_former_member: boolean;
      }>(
        ADMIN,
        'select membership_id, first_name, is_former_member from public.match_attendance_workspace($1)',
        [MATCH],
      );

      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.membership_id === DANA_MEMBERSHIP)!.first_name).toBe('Former');
    });

    it('does not use the scrubbed name as the signal', async () => {
      // A real person called Former must not be treated as deleted. The flag
      // comes from the lifecycle columns and nothing else.
      await db.pool.query(
        `update public.profiles set first_name = 'Former', last_name = 'member' where id = $1`,
        [members[0]!.user.id],
      );

      const rows = await callAs<{ membership_id: string; is_former_member: boolean }>(
        ADMIN,
        'select membership_id, is_former_member from public.match_roster_admin($1)',
        [MATCH],
      );

      expect(rows.find((row) => row.membership_id === members[0]!.membershipId)!.is_former_member).toBe(
        false,
      );
    });

    it('still drops a departed player from a match not yet played', async () => {
      // The other half of the temporal rule: a team sheet for a future match
      // must not list somebody who will not be there.
      await deleteAccount();

      const rows = await callAs<{ membership_id: string }>(
        members[0]!.user,
        'select membership_id from public.match_published_teams($1)',
        [MATCH],
      );
      expect(rows.map((row) => row.membership_id)).not.toContain(DANA_MEMBERSHIP);
    });
  });
});

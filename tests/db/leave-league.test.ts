import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asUser,
  asUserCommitting,
  createExtraMembers,
  createTestDatabase,
  expectDatabaseError,
  PG_ERROR,
  SEED_LEAGUES,
  SEED_MEMBERSHIPS,
  SEED_USERS,
  type ExtraMember,
  type SeedUser,
  type TestDatabase,
} from './helpers/harness';

/**
 * `leave_league()` — a player ending their own membership.
 *
 * The companion to `membership-status.test.ts`, which covers the same
 * consequences arriving from the other direction. The two share a cascade on
 * purpose, so the tests here concentrate on what is genuinely different:
 *
 *   * authorization derived from the session rather than from an argument;
 *   * the refusals — administrator, stranger, already gone, forged league;
 *   * that nothing is deleted;
 *   * that rejoining reattaches the same row, so leaving is not a sanction.
 */
describe('leaving a league', () => {
  let db: TestDatabase;
  let members: ExtraMember[];

  const league = SEED_LEAGUES.weeknightFives;
  const admin = SEED_USERS.fivesAdmin;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
    members = await createExtraMembers(db, league, 5);
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

  /** The action under test, as the person leaving. */
  async function leave(user: SeedUser, leagueId: string = league) {
    return callAs<{ leave_league: string }>(user, 'select public.leave_league($1)', [leagueId]);
  }

  async function membershipRow(membershipId: string) {
    const { rows } = await db.pool.query<{
      status: string;
      status_reason: string | null;
      suspended_until: string | null;
      role: string;
      status_changed_at: string;
    }>(
      `select status, status_reason, suspended_until::text, role, status_changed_at::text
         from public.league_memberships where id = $1`,
      [membershipId],
    );
    return rows[0] ?? null;
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await db.pool.query<{ n: string }>(sql, params);
    return Number(rows[0]!.n);
  }

  // ══ The departure itself ═════════════════════════════════════════════════

  describe('an active player leaving', () => {
    it('returns their own membership id', async () => {
      const rows = await leave(members[0]!.user);
      expect(rows[0]!.leave_league).toBe(members[0]!.membershipId);
    });

    it('sets the membership to removed', async () => {
      await leave(members[0]!.user);
      expect((await membershipRow(members[0]!.membershipId))!.status).toBe('removed');
    });

    it('records why, in the words the product chose', async () => {
      await leave(members[0]!.user);
      // Not free text, and not an administrator's justification. The reason is
      // what tells a later reader that nobody was thrown out.
      expect((await membershipRow(members[0]!.membershipId))!.status_reason).toBe(
        'Left voluntarily.',
      );
    });

    it('stamps when the status changed', async () => {
      const before = (await membershipRow(members[0]!.membershipId))!.status_changed_at;
      await leave(members[0]!.user);
      expect((await membershipRow(members[0]!.membershipId))!.status_changed_at).not.toBe(before);
    });

    it('deletes nothing — the row is still there', async () => {
      await leave(members[0]!.user);

      expect(
        await count('select count(*)::text as n from public.league_memberships where id = $1', [
          members[0]!.membershipId,
        ]),
      ).toBe(1);
    });

    it('keeps their other league untouched', async () => {
      // `multiLeaguePlayer` belongs to both seeded leagues, and leaving one is
      // a statement about one league.
      await leave(SEED_USERS.multiLeaguePlayer);

      expect((await membershipRow(SEED_MEMBERSHIPS.fivesMultiLeaguePlayer))!.status).toBe(
        'removed',
      );
      expect((await membershipRow(SEED_MEMBERSHIPS.rmvfcMultiLeaguePlayer))!.status).toBe('active');
    });

    it('does not disturb anybody else in the league', async () => {
      await leave(members[0]!.user);

      for (const other of members.slice(1)) {
        expect((await membershipRow(other.membershipId))!.status).toBe('active');
      }
    });
  });

  // ══ The audit trail ══════════════════════════════════════════════════════

  describe('the audit trail', () => {
    it('records the departing member as the actor, not an administrator', async () => {
      await leave(members[0]!.user);

      const { rows } = await db.pool.query<{
        action: string;
        actor_user_id: string;
        reason: string | null;
        before: { status: string };
        after: { status: string };
      }>(
        `select action, actor_user_id, reason, before_data as before, after_data as after
           from public.audit_events
          where action = 'membership.status_changed' and entity_id = $1`,
        [members[0]!.membershipId],
      );

      expect(rows).toHaveLength(1);
      // THE WHOLE REASON A FOURTH STATUS VALUE WAS NOT NEEDED. `removed` says
      // the membership ended; the actor says who ended it. A self-leave and an
      // administrator's removal are told apart here.
      expect(rows[0]!.actor_user_id).toBe(members[0]!.user.id);
      expect(rows[0]!.before.status).toBe('active');
      expect(rows[0]!.after.status).toBe('removed');
      expect(rows[0]!.reason).toBe('Left voluntarily.');
    });

    it('writes exactly one event, not one per path', async () => {
      await leave(members[0]!.user);

      expect(
        await count(
          `select count(*)::text as n from public.audit_events where entity_id = $1`,
          [members[0]!.membershipId],
        ),
      ).toBe(1);
    });
  });

  // ══ Authorization ════════════════════════════════════════════════════════

  describe('who may call it', () => {
    it('refuses an anonymous caller at the grant', async () => {
      const error = await expectDatabaseError(() =>
        asAnon(db, (client) => client.query('select public.leave_league($1)', [league])),
      );
      // Not even reached: `anon` holds no EXECUTE, so there is no code path to
      // audit here at all.
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });

    it('refuses somebody who is not a member of that league', async () => {
      const error = await expectDatabaseError(() => leave(SEED_USERS.outsider));
      expect(error.message).toContain('MEMBERSHIP_REQUIRED');
    });

    it('answers a league that does not exist exactly as it answers one you are not in', async () => {
      const missing = await expectDatabaseError(() =>
        leave(members[0]!.user, '00000000-0000-4000-8000-000000000000'),
      );
      const foreign = await expectDatabaseError(() => leave(members[0]!.user, SEED_LEAGUES.rmvfc));

      // A guessed id must not be able to confirm that a private league is real.
      expect(missing.message).toBe(foreign.message);
    });

    it('changes nothing when the league id is forged', async () => {
      await expectDatabaseError(() => leave(members[0]!.user, SEED_LEAGUES.rmvfc));

      // Not their own membership, and not anybody's in the named league.
      expect((await membershipRow(members[0]!.membershipId))!.status).toBe('active');
      expect((await membershipRow(SEED_MEMBERSHIPS.rmvfcPlayer))!.status).toBe('active');
      expect((await membershipRow(SEED_MEMBERSHIPS.rmvfcAdmin))!.status).toBe('active');
    });

    it('cannot be aimed at another member — there is no argument for it', async () => {
      // The security property stated as a test: the only argument is a league,
      // so the caller names *where* they are leaving, never *who* leaves.
      const { rows } = await db.pool.query<{ args: string }>(
        `select pg_get_function_arguments(p.oid) as args
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'leave_league'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.args).toBe('p_league_id uuid');
    });

    it('cannot be reached by a direct table update instead', async () => {
      await asUser(db, members[0]!.user, async (client) => {
        await client.query(`update public.league_memberships set status = 'removed' where id = $1`, [
          members[0]!.membershipId,
        ]);
      });

      // RLS gives a member no UPDATE on their own membership row, so the RPC
      // is not merely the convenient route — it is the only one.
      expect((await membershipRow(members[0]!.membershipId))!.status).toBe('active');
    });
  });

  // ══ The function's own shape ═════════════════════════════════════════════

  describe('the function definition', () => {
    async function proc() {
      const { rows } = await db.pool.query<{
        prosecdef: boolean;
        proconfig: string[] | null;
        proacl: string | null;
      }>(
        `select p.prosecdef, p.proconfig, p.proacl::text
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'leave_league'`,
      );
      return rows[0]!;
    }

    it('is SECURITY DEFINER', async () => {
      expect((await proc()).prosecdef).toBe(true);
    });

    it('pins an empty search_path', async () => {
      expect((await proc()).proconfig).toContain('search_path=""');
    });

    it('is not executable by PUBLIC', async () => {
      const { proacl } = await proc();
      expect(proacl).not.toBeNull();
      // A bare `=X/owner` entry is the PUBLIC grant. Its absence is the point.
      expect(proacl!).not.toMatch(/[{,]=[^/]*X/);
    });

    it('grants EXECUTE to exactly authenticated and service_role', async () => {
      const { rows } = await db.pool.query<{ grantee: string }>(
        `select unnest(array['authenticated', 'service_role', 'anon']) as grantee`,
      );
      const granted: string[] = [];
      for (const { grantee } of rows) {
        const { rows: check } = await db.pool.query<{ ok: boolean }>(
          `select has_function_privilege($1, 'public.leave_league(uuid)', 'execute') as ok`,
          [grantee],
        );
        if (check[0]!.ok) granted.push(grantee);
      }
      expect(granted.sort()).toEqual(['authenticated', 'service_role']);
    });
  });

  // ══ Which statuses may leave ═════════════════════════════════════════════

  describe('which memberships may leave', () => {
    it('lets a suspended member leave', async () => {
      // A suspension stops somebody playing. Turning it into "and you may never
      // leave" would make it a sanction the product does not otherwise impose.
      await callAs(
        admin,
        `select public.set_membership_status($1, 'suspended', 'Cooling-off period')`,
        [members[0]!.membershipId],
      );

      await leave(members[0]!.user);

      const row = (await membershipRow(members[0]!.membershipId))!;
      expect(row.status).toBe('removed');
      expect(row.status_reason).toBe('Left voluntarily.');
    });

    it('clears a suspension end date on the way out', async () => {
      const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
      await callAs(
        admin,
        `select public.set_membership_status($1, 'suspended', 'Cooling-off period', $2::timestamptz)`,
        [members[0]!.membershipId, until],
      );

      await leave(members[0]!.user);

      // The membership has ended; a date describing a suspension still in force
      // would be a lie about somebody who is no longer there.
      expect((await membershipRow(members[0]!.membershipId))!.suspended_until).toBeNull();
    });

    it('refuses somebody whose request has not been approved yet', async () => {
      // `pendingPlayer` has asked to join Weeknight 5v5 and is waiting. There is
      // no membership to leave — `withdraw_join_request()` cancels a request.
      const error = await expectDatabaseError(() => leave(SEED_USERS.pendingPlayer));
      expect(error.message).toContain('MEMBERSHIP_INACTIVE');
      expect((await membershipRow(SEED_MEMBERSHIPS.fivesPending))!.status).toBe('pending');
    });

    it('refuses somebody who has already left', async () => {
      await leave(members[0]!.user);

      const error = await expectDatabaseError(() => leave(members[0]!.user));
      expect(error.message).toContain('MEMBERSHIP_INACTIVE');
    });

    it('writes no second notification for a repeated call', async () => {
      await leave(members[0]!.user);
      await expectDatabaseError(() => leave(members[0]!.user));

      // The refusal above is what guarantees this: there is no path from an
      // already-removed membership to `create_notification`.
      expect(
        await count(
          `select count(*)::text as n from public.notifications
            where type = 'member_left' and league_id = $1`,
          [league],
        ),
      ).toBe(1);
    });
  });

  // ══ The administrator ════════════════════════════════════════════════════

  describe('the league administrator', () => {
    it('cannot leave', async () => {
      const error = await expectDatabaseError(() => leave(admin));
      expect(error.message).toContain('ADMIN_TRANSFER_INVALID');
    });

    it('is still the administrator afterwards', async () => {
      await expectDatabaseError(() => leave(admin));

      const row = (await membershipRow(SEED_MEMBERSHIPS.fivesAdmin))!;
      expect(row.status).toBe('active');
      expect(row.role).toBe('league_admin');
    });

    it('promotes nobody in their place', async () => {
      await expectDatabaseError(() => leave(admin));

      expect(
        await count(
          `select count(*)::text as n from public.league_memberships
            where league_id = $1 and role = 'league_admin'`,
          [league],
        ),
      ).toBe(1);
    });

    it('may leave once administration has been transferred', async () => {
      await callAs(admin, 'select public.transfer_league_administration($1, $2)', [
        league,
        members[0]!.membershipId,
      ]);

      expect((await membershipRow(SEED_MEMBERSHIPS.fivesAdmin))!.role).toBe('player');

      await leave(admin);

      expect((await membershipRow(SEED_MEMBERSHIPS.fivesAdmin))!.status).toBe('removed');
    });

    it('leaves the league with exactly one active administrator throughout', async () => {
      await callAs(admin, 'select public.transfer_league_administration($1, $2)', [
        league,
        members[0]!.membershipId,
      ]);
      await leave(admin);

      expect(
        await count(
          `select count(*)::text as n from public.league_memberships
            where league_id = $1 and role = 'league_admin' and status = 'active'`,
          [league],
        ),
      ).toBe(1);
    });

    it('still refuses the new administrator', async () => {
      await callAs(admin, 'select public.transfer_league_administration($1, $2)', [
        league,
        members[0]!.membershipId,
      ]);

      const error = await expectDatabaseError(() => leave(members[0]!.user));
      expect(error.message).toContain('ADMIN_TRANSFER_INVALID');
    });
  });

  // ══ The active-league pointer ════════════════════════════════════════════

  describe('the active-league pointer', () => {
    async function activeLeagueOf(userId: string): Promise<string | null> {
      const { rows } = await db.pool.query<{ active_league_id: string | null }>(
        'select active_league_id from public.user_app_state where user_id = $1',
        [userId],
      );
      return rows[0]?.active_league_id ?? null;
    }

    it('clears it when it pointed at the league being left', async () => {
      await db.pool.query(
        `insert into public.user_app_state (user_id, active_league_id) values ($1, $2)
           on conflict (user_id) do update set active_league_id = excluded.active_league_id`,
        [members[0]!.user.id, league],
      );

      await leave(members[0]!.user);

      expect(await activeLeagueOf(members[0]!.user.id)).toBeNull();
    });

    it('chooses no replacement in SQL', async () => {
      // `multiLeaguePlayer` still has RMVFC after leaving Weeknight 5v5, and the
      // pointer is still cleared rather than repointed: which league somebody
      // looks at next is `resolveActiveMembership`'s question, and answering it
      // here as well would be the same rule implemented twice.
      await db.pool.query(
        `insert into public.user_app_state (user_id, active_league_id) values ($1, $2)
           on conflict (user_id) do update set active_league_id = excluded.active_league_id`,
        [SEED_USERS.multiLeaguePlayer.id, league],
      );

      await leave(SEED_USERS.multiLeaguePlayer);

      expect(await activeLeagueOf(SEED_USERS.multiLeaguePlayer.id)).toBeNull();
    });

    it('leaves a pointer at a different league alone', async () => {
      await db.pool.query(
        `insert into public.user_app_state (user_id, active_league_id) values ($1, $2)
           on conflict (user_id) do update set active_league_id = excluded.active_league_id`,
        [SEED_USERS.multiLeaguePlayer.id, SEED_LEAGUES.rmvfc],
      );

      await leave(SEED_USERS.multiLeaguePlayer);

      expect(await activeLeagueOf(SEED_USERS.multiLeaguePlayer.id)).toBe(SEED_LEAGUES.rmvfc);
    });

    it('does not require the member to have any state row at all', async () => {
      await db.pool.query('delete from public.user_app_state where user_id = $1', [
        members[0]!.user.id,
      ]);

      await leave(members[0]!.user);

      expect((await membershipRow(members[0]!.membershipId))!.status).toBe('removed');
    });
  });

  // ══ Telling the administrator ════════════════════════════════════════════

  describe('the administrator notification', () => {
    async function memberLeft() {
      const { rows } = await db.pool.query<{
        recipient_user_id: string;
        title: string;
        body: string;
        deep_link: string;
        delivery_metadata: Record<string, unknown>;
        match_id: string | null;
      }>(
        `select recipient_user_id, title, body, deep_link, delivery_metadata, match_id
           from public.notifications where type = 'member_left'`,
      );
      return rows;
    }

    it('sends exactly one, to the active administrator', async () => {
      await leave(members[0]!.user);

      const rows = await memberLeft();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.recipient_user_id).toBe(admin.id);
    });

    it('names the person and the league', async () => {
      await leave(members[0]!.user);

      const [notification] = await memberLeft();
      expect(notification!.title).toBe('A member left');
      expect(notification!.body).toBe('Player1 Tester left Weeknight 5v5.');
    });

    it('deep-links to the members page', async () => {
      await leave(members[0]!.user);

      const [notification] = await memberLeft();
      expect(notification!.deep_link).toBe('/leagues/weeknight-5v5/members');
    });

    it('carries no delivery metadata, so nothing marks it push-eligible', async () => {
      await leave(members[0]!.user);

      const [notification] = await memberLeft();
      expect(notification!.delivery_metadata).toEqual({});
    });

    it('tells nobody else in the league', async () => {
      await leave(members[0]!.user);

      // Who is in a league is member-only information. Announcing a departure to
      // the roster would publish one person's decision to everybody.
      const rows = await memberLeft();
      expect(rows.map((row) => row.recipient_user_id)).toEqual([admin.id]);
    });

    it('sends the departing player nothing', async () => {
      await leave(members[0]!.user);

      expect(
        await count(
          `select count(*)::text as n from public.notifications
            where recipient_user_id = $1 and type = 'member_left'`,
          [members[0]!.user.id],
        ),
      ).toBe(0);
    });

    it('leaves the departing player their existing inbox', async () => {
      await db.pool.query(
        `insert into public.notifications
           (recipient_user_id, league_id, type, title, body, deep_link, idempotency_key)
         values ($1, $2, 'match_published', 'New match', 'Thursday', '/dashboard', 'keepme-0001')`,
        [members[0]!.user.id, league],
      );

      await leave(members[0]!.user);

      // Notifications hang off the profile, not the membership, so leaving
      // cannot take somebody's own history away from them.
      expect(
        await count(
          'select count(*)::text as n from public.notifications where recipient_user_id = $1',
          [members[0]!.user.id],
        ),
      ).toBe(1);
    });

    it('is not sent when the league has no active administrator to tell', async () => {
      // A state the product cannot reach — the deferred cardinality trigger
      // refuses any transaction that would commit it — so it is manufactured by
      // switching that trigger off for one statement. The point is that
      // `leave_league()` degrades to "nobody to tell" rather than falling over
      // on a null recipient: a departure must never fail because of a problem
      // with somebody else's membership.
      await db.pool.query(
        `alter table public.league_memberships
           disable trigger league_memberships_require_single_active_admin`,
      );
      await db.pool.query(
        `update public.league_memberships set status = 'suspended' where id = $1`,
        [SEED_MEMBERSHIPS.fivesAdmin],
      );

      try {
        // Still disabled here, and it has to be: the departure updates a
        // membership row, which is exactly what the constraint watches. Turning
        // it back on first would make the trigger reject this transaction for
        // the state the test deliberately created rather than for anything
        // `leave_league()` did.
        await leave(members[0]!.user);

        expect((await membershipRow(members[0]!.membershipId))!.status).toBe('removed');
        expect(await memberLeft()).toHaveLength(0);
      } finally {
        await db.pool.query(
          `alter table public.league_memberships
             enable trigger league_memberships_require_single_active_admin`,
        );
      }
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The cascade over future matches, and the history it must not touch.
// ══════════════════════════════════════════════════════════════════════════

describe('what leaving does to matches', () => {
  let db: TestDatabase;
  let members: ExtraMember[];

  const league = SEED_LEAGUES.weeknightFives;
  const admin = SEED_USERS.fivesAdmin;
  const match = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000011';

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
    await db.pool.query(
      'update public.matches set capacity = 6, min_players = 1 where id = $1',
      [match],
    );
    members = await createExtraMembers(db, league, 6);
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

  const leave = async (user: SeedUser) =>
    callAs(user, 'select public.leave_league($1)', [league]);

  const join = async (member: ExtraMember, matchId: string = match) =>
    callAs(member.user, 'select public.join_match($1)', [matchId]);

  async function signup(member: ExtraMember, matchId: string = match) {
    const { rows } = await db.pool.query<{
      status: string;
      waitlist_position: number | null;
      confirmed_at: string | null;
      canceled_at: string | null;
    }>(
      `select status, waitlist_position, confirmed_at::text, canceled_at::text
         from public.match_signups where match_id = $1 and membership_id = $2`,
      [matchId, member.membershipId],
    );
    return rows[0] ?? null;
  }

  async function confirmedCount(matchId: string = match): Promise<number> {
    const { rows } = await db.pool.query<{ count: number }>(
      'select public.match_confirmed_count($1) as count',
      [matchId],
    );
    return rows[0]!.count;
  }

  async function createFutureMatch(offset: string, title = 'Later match'): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `insert into public.matches (
         league_id, title, match_date, timezone, arrival_at, kickoff_at, end_at,
         location_name, capacity, min_players, selection_mode, waitlist_mode,
         signup_closes_at, cancellation_cutoff_at, status, published_at, created_by
       )
       select $1, $4, (now() + $2::interval)::date, l.timezone,
              now() + $2::interval - interval '30 minutes',
              now() + $2::interval,
              now() + $2::interval + interval '90 minutes',
              'Recreation ground', 6, 1, 'first_come', 'automatic',
              now() + $2::interval, now() + $2::interval - interval '1 day',
              'open', now(), $3
         from public.leagues l where l.id = $1
       returning id`,
      [league, offset, admin.id, title],
    );
    return rows[0]!.id;
  }

  /** Pushes a match into the past without touching anybody's signup. */
  async function moveToPast(matchId: string, ago: string) {
    await db.pool.query(
      `update public.matches
          set match_date = (now() - $2::interval)::date,
              arrival_at = now() - $2::interval - interval '30 minutes',
              kickoff_at = now() - $2::interval,
              end_at = now() - $2::interval + interval '90 minutes',
              signup_closes_at = now() - $2::interval,
              cancellation_cutoff_at = now() - $2::interval - interval '1 day'
        where id = $1`,
      [matchId, ago],
    );
  }

  // ══ Future matches ═══════════════════════════════════════════════════════

  describe('a future match they had a place in', () => {
    it('turns a confirmed spot into not_selected', async () => {
      await join(members[0]!);

      await leave(members[0]!.user);

      expect((await signup(members[0]!))!.status).toBe('not_selected');
    });

    it('keeps confirmed_at, so the register can still say they were in', async () => {
      await join(members[0]!);
      const before = (await signup(members[0]!))!.confirmed_at;

      await leave(members[0]!.user);

      expect((await signup(members[0]!))!.confirmed_at).toBe(before);
    });

    it('does not record it as a cancellation by the player', async () => {
      await join(members[0]!);

      await leave(members[0]!.user);

      expect((await signup(members[0]!))!.canceled_at).toBeNull();
    });

    it('releases the capacity they were holding', async () => {
      await join(members[0]!);
      await join(members[1]!);
      expect(await confirmedCount()).toBe(2);

      await leave(members[0]!.user);

      expect(await confirmedCount()).toBe(1);
    });

    it('promotes the next waitlisted player in automatic mode', async () => {
      await db.pool.query(
        `update public.matches set capacity = 2, waitlist_mode = 'automatic' where id = $1`,
        [match],
      );
      await join(members[0]!);
      await join(members[1]!);
      await join(members[2]!);

      await leave(members[0]!.user);

      expect((await signup(members[2]!))!.status).toBe('confirmed');
      expect(await confirmedCount()).toBe(2);
    });

    it('leaves the spot open in administrator-controlled mode', async () => {
      await db.pool.query(
        `update public.matches set capacity = 2, waitlist_mode = 'admin_controlled' where id = $1`,
        [match],
      );
      await join(members[0]!);
      await join(members[1]!);
      await join(members[2]!);

      await leave(members[0]!.user);

      expect((await signup(members[2]!))!.status).toBe('waitlisted');
      expect(await confirmedCount()).toBe(1);
    });

    it('takes a waitlisted player off the waitlist', async () => {
      await db.pool.query('update public.matches set capacity = 2 where id = $1', [match]);
      await join(members[0]!);
      await join(members[1]!);
      await join(members[2]!);

      await leave(members[2]!.user);

      const row = (await signup(members[2]!))!;
      expect(row.status).toBe('not_selected');
      expect(row.waitlist_position).toBeNull();
    });

    it('closes the gap without reordering the people around it', async () => {
      await db.pool.query('update public.matches set capacity = 2 where id = $1', [match]);
      for (const member of members.slice(0, 5)) {
        await join(member);
      }
      // members[2], [3], [4] are waitlisted in that order.
      await leave(members[3]!.user);

      const { rows } = await db.pool.query<{ membership_id: string; waitlist_position: number }>(
        `select membership_id, waitlist_position from public.match_signups
          where match_id = $1 and status = 'waitlisted' order by waitlist_position`,
        [match],
      );
      expect(rows.map((row) => row.waitlist_position)).toEqual([1, 2]);
      // Relative order preserved: the person behind the gap moves up, they do
      // not swap with the person in front of it.
      expect(rows.map((row) => row.membership_id)).toEqual([
        members[2]!.membershipId,
        members[4]!.membershipId,
      ]);
    });

    it('turns a merely interested signup into not_selected', async () => {
      await db.pool.query(
        `update public.matches set selection_mode = 'admin_approval' where id = $1`,
        [match],
      );
      await callAs(members[0]!.user, 'select public.request_spot($1)', [match]);
      expect((await signup(members[0]!))!.status).toBe('interested');

      await leave(members[0]!.user);

      expect((await signup(members[0]!))!.status).toBe('not_selected');
    });

    it('reaches every future match, not only the next one', async () => {
      const later = await createFutureMatch('9 days');
      await join(members[0]!);
      await join(members[0]!, later);

      await leave(members[0]!.user);

      expect((await signup(members[0]!))!.status).toBe('not_selected');
      expect((await signup(members[0]!, later))!.status).toBe('not_selected');
    });

    it('deletes no signup row anywhere', async () => {
      const later = await createFutureMatch('9 days');
      await join(members[0]!);
      await join(members[0]!, later);

      await leave(members[0]!.user);

      const { rows } = await db.pool.query<{ n: string }>(
        'select count(*)::text as n from public.match_signups where membership_id = $1',
        [members[0]!.membershipId],
      );
      expect(Number(rows[0]!.n)).toBe(2);
    });
  });

  // ══ Published rosters and teams ══════════════════════════════════════════

  describe('when the roster and teams are published', () => {
    async function publishRosterAndTeams() {
      await callAs(admin, 'select public.finalize_roster($1)', [match]);
      await callAs(admin, 'select public.ensure_match_teams($1)', [match]);
      await callAs(admin, 'select public.randomize_match_teams($1)', [match]);
      await callAs(admin, 'select public.publish_match_teams($1)', [match]);
    }

    async function revisions() {
      const { rows } = await db.pool.query<{ roster_revision: number; team_revision: number }>(
        'select roster_revision, team_revision from public.matches where id = $1',
        [match],
      );
      return rows[0]!;
    }

    it('advances the roster revision once', async () => {
      await join(members[0]!);
      await join(members[1]!);
      await publishRosterAndTeams();
      const before = await revisions();

      await leave(members[0]!.user);

      expect((await revisions()).roster_revision).toBe(before.roster_revision + 1);
    });

    it('advances the team revision once', async () => {
      await join(members[0]!);
      await join(members[1]!);
      await publishRosterAndTeams();
      const before = await revisions();

      await leave(members[0]!.user);

      expect((await revisions()).team_revision).toBe(before.team_revision + 1);
    });

    it('takes them out of the teams the other players can see', async () => {
      await join(members[0]!);
      await join(members[1]!);
      await publishRosterAndTeams();

      await leave(members[0]!.user);

      const rows = await callAs<{ membership_id: string }>(
        members[1]!.user,
        'select membership_id from public.match_published_teams($1)',
        [match],
      );
      expect(rows.map((row) => row.membership_id)).not.toContain(members[0]!.membershipId);
    });

    it('tells the remaining players once that the teams changed', async () => {
      await join(members[0]!);
      await join(members[1]!);
      await publishRosterAndTeams();

      await leave(members[0]!.user);

      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.notifications
          where match_id = $1 and type = 'teams_changed' and recipient_user_id = $2`,
        [match, members[1]!.user.id],
      );
      expect(rows[0]!.n).toBe('1');
    });

    it('drops their draft team assignment', async () => {
      await join(members[0]!);
      await join(members[1]!);
      await publishRosterAndTeams();

      await leave(members[0]!.user);

      // The FUTURE team sheet, which is scheduling and must be corrected. The
      // publication entries for matches already played are a different thing
      // entirely — see the history tests below.
      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.match_team_assignments
          where match_id = $1 and membership_id = $2`,
        [match, members[0]!.membershipId],
      );
      expect(rows[0]!.n).toBe('0');
    });
  });

  // ══ History ══════════════════════════════════════════════════════════════

  describe('history it must not touch', () => {
    it('leaves a match that has already kicked off alone', async () => {
      await join(members[0]!);
      await moveToPast(match, '2 hours');

      await leave(members[0]!.user);

      expect((await signup(members[0]!))!.status).toBe('confirmed');
    });

    it('leaves a completed match alone', async () => {
      await join(members[0]!);
      await moveToPast(match, '2 days');
      await db.pool.query(`update public.matches set status = 'completed', completed_at = now() where id = $1`, [match]);

      await leave(members[0]!.user);

      expect((await signup(members[0]!))!.status).toBe('confirmed');
    });

    it('leaves a cancelled match alone', async () => {
      await join(members[0]!);
      await db.pool.query(
        `update public.matches
            set status = 'canceled', canceled_at = now(), cancellation_reason = 'Waterlogged'
          where id = $1`,
        [match],
      );

      await leave(members[0]!.user);

      expect((await signup(members[0]!))!.status).toBe('confirmed');
    });

    it('keeps an attendance record, outcome and all', async () => {
      await join(members[0]!);
      await moveToPast(match, '2 days');
      await callAs(admin, `select public.record_attendance($1, $2, 'no_show')`, [
        match,
        members[0]!.membershipId,
      ]);

      await leave(members[0]!.user);

      const { rows } = await db.pool.query<{ outcome: string }>(
        'select outcome::text from public.attendance_records where membership_id = $1',
        [members[0]!.membershipId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outcome).toBe('no_show');
    });

    it('keeps the published team sheet of a match that was played', async () => {
      await join(members[0]!);
      await join(members[1]!);
      await callAs(admin, 'select public.finalize_roster($1)', [match]);
      await callAs(admin, 'select public.ensure_match_teams($1)', [match]);
      await callAs(admin, 'select public.randomize_match_teams($1)', [match]);
      await callAs(admin, 'select public.publish_match_teams($1)', [match]);
      const before = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.match_team_publication_entries e
           join public.match_team_publications p on p.id = e.publication_id
          where p.match_id = $1 and e.membership_id = $2`,
        [match, members[0]!.membershipId],
      );
      expect(Number(before.rows[0]!.n)).toBeGreaterThan(0);

      await moveToPast(match, '2 days');
      await db.pool.query(`update public.matches set status = 'completed', completed_at = now() where id = $1`, [match]);

      await leave(members[0]!.user);

      // The match is over. Rewriting who played in it would make the record of
      // a real evening disagree with what happened.
      const after = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.match_team_publication_entries e
           join public.match_team_publications p on p.id = e.publication_id
          where p.match_id = $1 and e.membership_id = $2`,
        [match, members[0]!.membershipId],
      );
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    });

    it('keeps their guideline acceptances', async () => {
      const before = await db.pool.query<{ n: string }>(
        'select count(*)::text as n from public.guideline_acceptances where membership_id = $1',
        [members[0]!.membershipId],
      );

      await leave(members[0]!.user);

      const after = await db.pool.query<{ n: string }>(
        'select count(*)::text as n from public.guideline_acceptances where membership_id = $1',
        [members[0]!.membershipId],
      );
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    });

    it('keeps the administrator notes written about them', async () => {
      await db.pool.query(
        `insert into public.league_membership_admin_notes
           (league_id, membership_id, note, created_by)
         values ($1, $2, $3, $4)`,
        [league, members[0]!.membershipId, 'Plays left back. Reliable.', admin.id],
      );

      await leave(members[0]!.user);

      const { rows } = await db.pool.query<{ note: string }>(
        'select note from public.league_membership_admin_notes where membership_id = $1',
        [members[0]!.membershipId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.note).toBe('Plays left back. Reliable.');
    });
  });

  // ══ Atomicity ════════════════════════════════════════════════════════════

  describe('when part of the cascade fails', () => {
    /**
     * Fault injection, deliberately at the last step the cascade takes.
     *
     * The trigger refuses the withdrawal on ONE named match. The two matches are
     * visited in `id` order, so aiming at the later one guarantees the first
     * withdrawal has already been written when the failure arrives — which is
     * the only arrangement that can tell a real transaction from a lucky one.
     */
    async function breakWithdrawalOn(matchId: string) {
      await db.pool.query(
        `create function public.test_break_withdrawal() returns trigger
           language plpgsql as $fn$
           begin
             if new.match_id = '${matchId}'::uuid and new.status = 'not_selected' then
               raise exception 'TEST_INJECTED_FAILURE';
             end if;
             return new;
           end
         $fn$;
         create trigger test_break_withdrawal before update on public.match_signups
           for each row execute function public.test_break_withdrawal();`,
      );
    }

    async function clearFault() {
      await db.pool.query(
        `drop trigger if exists test_break_withdrawal on public.match_signups;
         drop function if exists public.test_break_withdrawal();`,
      );
    }

    it('rolls the whole departure back', async () => {
      const later = await createFutureMatch('9 days');
      await join(members[0]!);
      await join(members[1]!);
      await join(members[0]!, later);

      // Whichever of the two sorts later is where the failure is aimed.
      const { rows } = await db.pool.query<{ id: string }>(
        'select id from public.matches where id = any($1::uuid[]) order by id desc limit 1',
        [[match, later]],
      );
      const lastVisited = rows[0]!.id;
      const firstVisited = lastVisited === match ? later : match;

      await breakWithdrawalOn(lastVisited);
      try {
        const error = await expectDatabaseError(() => leave(members[0]!.user));
        expect(error.message).toContain('TEST_INJECTED_FAILURE');
      } finally {
        await clearFault();
      }

      // 1. The membership never left.
      const { rows: membership } = await db.pool.query<{
        status: string;
        status_reason: string | null;
      }>('select status, status_reason from public.league_memberships where id = $1', [
        members[0]!.membershipId,
      ]);
      expect(membership[0]!.status).toBe('active');
      expect(membership[0]!.status_reason).toBeNull();

      // 2. No half-finished withdrawal survives — including the one that had
      //    already succeeded before the failure.
      expect((await signup(members[0]!, firstVisited))!.status).toBe('confirmed');
      expect((await signup(members[0]!, lastVisited))!.status).toBe('confirmed');
      expect(await confirmedCount(firstVisited)).toBe(firstVisited === match ? 2 : 1);

      // 3. No notification claims a departure that did not happen.
      const { rows: notifications } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.notifications where type = 'member_left'`,
      );
      expect(notifications[0]!.n).toBe('0');
    });

    it('leaves the active-league pointer where it was', async () => {
      await db.pool.query(
        `insert into public.user_app_state (user_id, active_league_id) values ($1, $2)
           on conflict (user_id) do update set active_league_id = excluded.active_league_id`,
        [members[0]!.user.id, league],
      );
      await join(members[0]!);

      await breakWithdrawalOn(match);
      try {
        await expectDatabaseError(() => leave(members[0]!.user));
      } finally {
        await clearFault();
      }

      const { rows } = await db.pool.query<{ active_league_id: string | null }>(
        'select active_league_id from public.user_app_state where user_id = $1',
        [members[0]!.user.id],
      );
      expect(rows[0]!.active_league_id).toBe(league);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Coming back.
// ══════════════════════════════════════════════════════════════════════════

describe('rejoining after leaving', () => {
  let db: TestDatabase;
  let members: ExtraMember[];

  const league = SEED_LEAGUES.weeknightFives;
  const admin = SEED_USERS.fivesAdmin;
  const match = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000011';

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
    await db.pool.query(
      'update public.matches set capacity = 6, min_players = 1 where id = $1',
      [match],
    );
    members = await createExtraMembers(db, league, 2);
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

  const leave = async (user: SeedUser) =>
    callAs(user, 'select public.leave_league($1)', [league]);

  async function membershipOf(userId: string) {
    const { rows } = await db.pool.query<{ id: string; status: string; role: string }>(
      'select id, status, role from public.league_memberships where league_id = $1 and user_id = $2',
      [league, userId],
    );
    return rows[0] ?? null;
  }

  it('lets them ask to join again', async () => {
    await leave(members[0]!.user);

    // Nothing marks a departed member as barred. Leaving is not a sanction, so
    // it must not behave like one.
    const rows = await callAs<{ request_to_join_league: string }>(
      members[0]!.user,
      'select public.request_to_join_league($1, $2)',
      [league, 'Back for the winter season'],
    );
    expect(rows[0]!.request_to_join_league).not.toBeNull();
  });

  it('revives the same membership row on approval', async () => {
    const original = (await membershipOf(members[0]!.user.id))!.id;
    await leave(members[0]!.user);

    const [request] = await callAs<{ request_to_join_league: string }>(
      members[0]!.user,
      'select public.request_to_join_league($1)',
      [league],
    );
    await callAs(admin, 'select public.decide_join_request($1, true)', [
      request!.request_to_join_league,
    ]);

    const after = (await membershipOf(members[0]!.user.id))!;
    // The same id, which is what makes every historical record reattach with no
    // migration, no backfill and no copying.
    expect(after.id).toBe(original);
    expect(after.status).toBe('active');
    expect(after.role).toBe('player');
  });

  it('revives the same membership row through an invitation', async () => {
    const original = (await membershipOf(members[0]!.user.id))!.id;
    await leave(members[0]!.user);

    const token = 'matchday-e2e-rejoin-token-000000000001';
    await callAs(admin, 'select public.create_league_invite($1, $2)', [league, token]);
    await callAs(members[0]!.user, 'select public.redeem_league_invite($1)', [token]);

    const after = (await membershipOf(members[0]!.user.id))!;
    expect(after.id).toBe(original);
    expect(after.status).toBe('active');
  });

  it('reconnects their history without moving a single row', async () => {
    await callAs(members[0]!.user, 'select public.join_match($1)', [match]);
    await db.pool.query(
      `update public.matches
          set match_date = (now() - interval '2 days')::date,
              arrival_at = now() - interval '2 days',
              kickoff_at = now() - interval '2 days' + interval '30 minutes',
              end_at = now() - interval '2 days' + interval '2 hours',
              signup_closes_at = now() - interval '2 days',
              cancellation_cutoff_at = now() - interval '3 days'
        where id = $1`,
      [match],
    );
    await callAs(admin, `select public.record_attendance($1, $2, 'attended')`, [
      match,
      members[0]!.membershipId,
    ]);

    await leave(members[0]!.user);
    const [request] = await callAs<{ request_to_join_league: string }>(
      members[0]!.user,
      'select public.request_to_join_league($1)',
      [league],
    );
    await callAs(admin, 'select public.decide_join_request($1, true)', [
      request!.request_to_join_league,
    ]);

    const { rows } = await db.pool.query<{ outcome: string; signup_status: string }>(
      `select a.outcome::text as outcome, s.status::text as signup_status
         from public.attendance_records a
         join public.match_signups s
           on s.match_id = a.match_id and s.membership_id = a.membership_id
        where a.membership_id = $1`,
      [members[0]!.membershipId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('attended');
    expect(rows[0]!.signup_status).toBe('confirmed');
  });

  it('treats a second departure as a new event', async () => {
    await leave(members[0]!.user);
    const [request] = await callAs<{ request_to_join_league: string }>(
      members[0]!.user,
      'select public.request_to_join_league($1)',
      [league],
    );
    await callAs(admin, 'select public.decide_join_request($1, true)', [
      request!.request_to_join_league,
    ]);

    await leave(members[0]!.user);

    // Two genuine departures, months apart in real life, so two notifications —
    // the idempotency key carries the moment as well as the membership.
    const { rows } = await db.pool.query<{ n: string }>(
      `select count(*)::text as n from public.notifications
        where type = 'member_left' and league_id = $1`,
      [league],
    );
    expect(rows[0]!.n).toBe('2');
  });

  it('lets them sign up for matches again once back', async () => {
    await leave(members[0]!.user);
    const [request] = await callAs<{ request_to_join_league: string }>(
      members[0]!.user,
      'select public.request_to_join_league($1)',
      [league],
    );
    await callAs(admin, 'select public.decide_join_request($1, true)', [
      request!.request_to_join_league,
    ]);

    await callAs(members[0]!.user, 'select public.join_match($1)', [match]);

    const { rows } = await db.pool.query<{ status: string }>(
      'select status from public.match_signups where match_id = $1 and membership_id = $2',
      [match, members[0]!.membershipId],
    );
    expect(rows[0]!.status).toBe('confirmed');
  });

  it('blocks them from the league while they are gone', async () => {
    await leave(members[0]!.user);

    const error = await expectDatabaseError(() =>
      callAs(members[0]!.user, 'select public.join_match($1)', [match]),
    );
    expect(error.message).toMatch(/MEMBERSHIP_REQUIRED|MEMBERSHIP_INACTIVE/);
  });
});

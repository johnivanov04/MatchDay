import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asUser,
  asUserCommitting,
  createExtraMembers,
  createTestDatabase,
  expectDatabaseError,
  SEED_LEAGUES,
  SEED_MATCHES,
  SEED_MEMBERSHIPS,
  SEED_USERS,
  type ExtraMember,
  type SeedUser,
  type TestDatabase,
} from './helpers/harness';

/**
 * Phase 7L/7M/7N — suspending, removing and reactivating a member, and what
 * that does to the matches they had already signed up for.
 */
describe('membership status', () => {
  let db: TestDatabase;
  let members: ExtraMember[];

  const admin = SEED_USERS.fivesAdmin;
  const match = SEED_MATCHES.fivesOpen;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
    await db.pool.query(
      'update public.matches set capacity = 6, min_players = 1 where id = $1',
      [match],
    );
    members = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 6);
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

  async function join(member: ExtraMember, matchId: string = match) {
    await callAs(member.user, 'select public.join_match($1)', [matchId]);
  }

  async function setStatus(
    member: ExtraMember,
    status: string,
    reason: string | null = 'Repeated abuse in the group chat',
    suspendedUntil: string | null = null,
    user: SeedUser = admin,
  ) {
    return callAs(
      user,
      `select public.set_membership_status($1, $2::public.membership_status, $3, $4::timestamptz)`,
      [member.membershipId, status, reason, suspendedUntil],
    );
  }

  async function membership(member: ExtraMember) {
    const { rows } = await db.pool.query<{
      status: string;
      status_reason: string | null;
      suspended_until: string | null;
    }>(
      `select status, status_reason, suspended_until::text
         from public.league_memberships where id = $1`,
      [member.membershipId],
    );
    return rows[0]!;
  }

  async function signupStatus(member: ExtraMember, matchId: string = match) {
    const { rows } = await db.pool.query<{
      status: string;
      waitlist_position: number | null;
      canceled_at: string | null;
    }>(
      `select status, waitlist_position, canceled_at::text from public.match_signups
        where match_id = $1 and membership_id = $2`,
      [matchId, member.membershipId],
    );
    return rows[0] ?? null;
  }

  async function confirmedCount(matchId: string = match) {
    const { rows } = await db.pool.query<{ count: number }>(
      'select public.match_confirmed_count($1) as count',
      [matchId],
    );
    return rows[0]!.count;
  }

  /** A second, later match in the same league, published and open. */
  async function createFutureMatch(offset: string): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `insert into public.matches (
         league_id, title, match_date, timezone, arrival_at, kickoff_at, end_at,
         location_name, capacity, min_players, selection_mode, waitlist_mode,
         signup_closes_at, cancellation_cutoff_at, status, published_at, created_by
       )
       select $1, 'Later match', (now() + $2::interval)::date, l.timezone,
              now() + $2::interval - interval '30 minutes',
              now() + $2::interval,
              now() + $2::interval + interval '90 minutes',
              'Recreation ground', 6, 1, 'first_come', 'automatic',
              now() + $2::interval, now() + $2::interval - interval '1 day',
              'open', now(), $3
         from public.leagues l where l.id = $1
       returning id`,
      [SEED_LEAGUES.weeknightFives, offset, admin.id],
    );
    return rows[0]!.id;
  }

  // ══ The status change itself ═════════════════════════════════════════════

  describe('setting the status', () => {
    it('suspends a member with a reason', async () => {
      await setStatus(members[0]!, 'suspended', 'Abusive language at the pitch');

      expect(await membership(members[0]!)).toMatchObject({
        status: 'suspended',
        status_reason: 'Abusive language at the pitch',
      });
    });

    it('records an intended end date without acting on it', async () => {
      const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
      await setStatus(members[0]!, 'suspended', 'Cooling-off period', until);

      const row = await membership(members[0]!);
      expect(row.status).toBe('suspended');
      expect(row.suspended_until).not.toBeNull();
    });

    it('removes a member with a reason', async () => {
      await setStatus(members[0]!, 'removed', 'Left the club');

      expect(await membership(members[0]!)).toMatchObject({ status: 'removed' });
    });

    it('reactivates a suspended member', async () => {
      await setStatus(members[0]!, 'suspended', 'Cooling-off period');
      await setStatus(members[0]!, 'active', 'Spoke to them; sorted');

      expect(await membership(members[0]!)).toMatchObject({ status: 'active' });
    });

    it('clears the suspension end date on reactivation', async () => {
      const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
      await setStatus(members[0]!, 'suspended', 'Cooling-off period', until);
      await setStatus(members[0]!, 'active', null);

      expect((await membership(members[0]!)).suspended_until).toBeNull();
    });

    it('requires a reason to suspend', async () => {
      const error = await expectDatabaseError(() => setStatus(members[0]!, 'suspended', '  '));
      expect(error.message).toContain('VALIDATION_FAILED');
    });

    it('requires a reason to remove', async () => {
      const error = await expectDatabaseError(() => setStatus(members[0]!, 'removed', null));
      expect(error.message).toContain('VALIDATION_FAILED');
    });

    it('does not require a reason to reactivate', async () => {
      await setStatus(members[0]!, 'suspended', 'Cooling-off period');
      await setStatus(members[0]!, 'active', null);

      expect((await membership(members[0]!)).status).toBe('active');
    });

    it('never expires a suspension on its own', async () => {
      // An end date already in the past changes nothing without an
      // administrator acting: there is no job that reactivates anybody.
      await db.pool.query(
        `update public.league_memberships
            set status = 'suspended', suspended_until = now() - interval '30 days'
          where id = $1`,
        [members[0]!.membershipId],
      );

      expect((await membership(members[0]!)).status).toBe('suspended');
    });

    it('writes an audit event carrying the reason', async () => {
      await setStatus(members[0]!, 'suspended', 'Abusive language at the pitch');

      const { rows } = await db.pool.query<{
        action: string;
        reason: string;
        before: { status: string };
        after: { status: string };
      }>(
        `select action, reason, before_data as before, after_data as after
           from public.audit_events
          where action = 'membership.status_changed' and entity_id = $1`,
        [members[0]!.membershipId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.before.status).toBe('active');
      expect(rows[0]!.after.status).toBe('suspended');
      expect(rows[0]!.reason).toBe('Abusive language at the pitch');
    });

    it('never places the reason in a notification', async () => {
      await join(members[0]!);
      await setStatus(members[0]!, 'suspended', 'Threatened another player');

      const { rows } = await db.pool.query<{ blob: string }>(
        `select title || ' ' || body as blob from public.notifications`,
      );
      expect(rows.every((r) => !r.blob.includes('Threatened'))).toBe(true);
    });
  });

  // ══ 7M — the sole administrator ══════════════════════════════════════════

  describe('the sole league administrator', () => {
    const adminMembership = { membershipId: SEED_MEMBERSHIPS.fivesAdmin } as ExtraMember;

    it('cannot be suspended', async () => {
      const error = await expectDatabaseError(() =>
        setStatus(adminMembership, 'suspended', 'Testing'),
      );
      expect(error.message).toContain('ADMIN_TRANSFER_INVALID');
    });

    it('cannot be removed', async () => {
      const error = await expectDatabaseError(() =>
        setStatus(adminMembership, 'removed', 'Testing'),
      );
      expect(error.message).toContain('ADMIN_TRANSFER_INVALID');
    });

    it('is still there afterwards', async () => {
      await expectDatabaseError(() => setStatus(adminMembership, 'removed', 'Testing'));

      const { rows } = await db.pool.query<{ status: string }>(
        'select status from public.league_memberships where id = $1',
        [SEED_MEMBERSHIPS.fivesAdmin],
      );
      expect(rows[0]!.status).toBe('active');
    });

    it('can be removed once administration has been transferred', async () => {
      await callAs(admin, 'select public.transfer_league_administration($1, $2)', [
        SEED_LEAGUES.weeknightFives,
        members[0]!.membershipId,
      ]);

      await setStatus(adminMembership, 'removed', 'Stepping away', null, members[0]!.user);

      const { rows } = await db.pool.query<{ status: string }>(
        'select status from public.league_memberships where id = $1',
        [SEED_MEMBERSHIPS.fivesAdmin],
      );
      expect(rows[0]!.status).toBe('removed');
    });
  });

  // ══ Authorization ════════════════════════════════════════════════════════

  describe('authorization', () => {
    it('refuses a player', async () => {
      const error = await expectDatabaseError(() =>
        setStatus(members[0]!, 'suspended', 'Testing', null, members[1]!.user),
      );
      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
    });

    it('refuses the member acting on themselves', async () => {
      const error = await expectDatabaseError(() =>
        setStatus(members[0]!, 'active', null, null, members[0]!.user),
      );
      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
    });

    it('refuses an administrator of another league', async () => {
      const error = await expectDatabaseError(() =>
        setStatus(members[0]!, 'suspended', 'Testing', null, SEED_USERS.rmvfcAdmin),
      );
      expect(error.message).toContain('NOT_LEAGUE_ADMIN');
    });

    it('answers a membership that does not exist exactly as it answers one in another league', async () => {
      const missing = await expectDatabaseError(() =>
        callAs(
          admin,
          `select public.set_membership_status($1, 'suspended', 'Testing')`,
          ['00000000-0000-4000-8000-000000000000'],
        ),
      );
      const foreign = await expectDatabaseError(() =>
        callAs(admin, `select public.set_membership_status($1, 'suspended', 'Testing')`, [
          SEED_MEMBERSHIPS.rmvfcPlayer,
        ]),
      );
      expect(missing.message).toBe(foreign.message);
    });

    it('cannot be reached by a direct table update', async () => {
      await asUser(db, members[1]!.user, async (client) => {
        await client.query(
          `update public.league_memberships set status = 'removed' where id = $1`,
          [members[0]!.membershipId],
        );
      });

      expect((await membership(members[0]!)).status).toBe('active');
    });
  });

  // ══ 7N — the cascade ═════════════════════════════════════════════════════

  describe('what happens to matches they were signed up for', () => {
    it('releases the capacity they were holding', async () => {
      await join(members[0]!);
      await join(members[1]!);
      expect(await confirmedCount()).toBe(2);

      await setStatus(members[0]!, 'suspended');

      expect(await confirmedCount()).toBe(1);
    });

    it('does not record it as a cancellation by the player', async () => {
      await join(members[0]!);

      await setStatus(members[0]!, 'suspended');

      const row = await signupStatus(members[0]!);
      // `not_selected` — an administrator decided they are not playing. Writing
      // `canceled` would claim the player withdrew, which they did not, and
      // would land them a cancellation receipt saying so.
      expect(row!.status).toBe('not_selected');
      expect(row!.canceled_at).toBeNull();
    });

    it('never classifies it as a late withdrawal', async () => {
      await join(members[0]!);
      await db.pool.query(
        `update public.matches set cancellation_cutoff_at = now() - interval '1 hour'
          where id = $1`,
        [match],
      );

      await setStatus(members[0]!, 'suspended');

      expect((await signupStatus(members[0]!))!.status).toBe('not_selected');
    });

    it('sends the player no cancellation receipt', async () => {
      await join(members[0]!);

      await setStatus(members[0]!, 'suspended');

      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.notifications
          where recipient_user_id = $1 and type = 'cancellation_receipt'`,
        [members[0]!.user.id],
      );
      expect(rows[0]!.n).toBe('0');
    });

    it('raises no late-cancellation alert', async () => {
      await join(members[0]!);
      await db.pool.query(
        `update public.matches set cancellation_cutoff_at = now() - interval '1 hour'
          where id = $1`,
        [match],
      );

      await setStatus(members[0]!, 'suspended');

      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.notifications
          where type = 'late_cancellation'`,
      );
      expect(rows[0]!.n).toBe('0');
    });

    it('takes them off the waitlist too', async () => {
      await db.pool.query('update public.matches set capacity = 2 where id = $1', [match]);
      await join(members[0]!);
      await join(members[1]!);
      await join(members[2]!); // waitlisted

      await setStatus(members[2]!, 'removed', 'Left the club');

      const row = await signupStatus(members[2]!);
      expect(row!.status).toBe('not_selected');
      expect(row!.waitlist_position).toBeNull();
    });

    it('closes the gap they left in the waitlist order', async () => {
      await db.pool.query('update public.matches set capacity = 2 where id = $1', [match]);
      for (const member of members.slice(0, 5)) {
        await join(member);
      }

      await setStatus(members[3]!, 'removed', 'Left the club');

      const { rows } = await db.pool.query<{ waitlist_position: number }>(
        `select waitlist_position from public.match_signups
          where match_id = $1 and status = 'waitlisted' order by waitlist_position`,
        [match],
      );
      expect(rows.map((r) => r.waitlist_position)).toEqual([1, 2]);
    });

    it('promotes the next waitlisted player in automatic mode', async () => {
      await db.pool.query(
        `update public.matches set capacity = 2, waitlist_mode = 'automatic' where id = $1`,
        [match],
      );
      await join(members[0]!);
      await join(members[1]!);
      await join(members[2]!);

      await setStatus(members[0]!, 'suspended');

      expect((await signupStatus(members[2]!))!.status).toBe('confirmed');
      expect(await confirmedCount()).toBe(2);
    });

    it('leaves the spot open in administrator-controlled mode', async () => {
      await db.pool.query(
        `update public.matches set capacity = 2, waitlist_mode = 'admin_controlled'
          where id = $1`,
        [match],
      );
      await join(members[0]!);
      await join(members[1]!);
      await join(members[2]!);

      await setStatus(members[0]!, 'suspended');

      expect((await signupStatus(members[2]!))!.status).toBe('waitlisted');
      expect(await confirmedCount()).toBe(1);
    });

    it('touches every future match, not only the next one', async () => {
      const later = await createFutureMatch('9 days');
      await join(members[0]!);
      await join(members[0]!, later);

      await setStatus(members[0]!, 'removed', 'Left the club');

      expect((await signupStatus(members[0]!))!.status).toBe('not_selected');
      expect((await signupStatus(members[0]!, later))!.status).toBe('not_selected');
    });

    it('leaves a match that has already kicked off alone', async () => {
      await join(members[0]!);
      await db.pool.query(
        `update public.matches
            set match_date = (now() - interval '2 hours')::date,
                arrival_at = now() - interval '3 hours',
                kickoff_at = now() - interval '2 hours',
                end_at = now() - interval '30 minutes',
                signup_closes_at = now() - interval '2 hours',
                cancellation_cutoff_at = now() - interval '2 hours'
          where id = $1`,
        [match],
      );

      await setStatus(members[0]!, 'removed', 'Left the club');

      // They played. Rewriting that would make the attendance register lie.
      expect((await signupStatus(members[0]!))!.status).toBe('confirmed');
    });

    it('leaves their attendance record for a past match untouched', async () => {
      await join(members[0]!);
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
      await callAs(admin, `select public.record_attendance($1, $2, 'no_show')`, [
        match,
        members[0]!.membershipId,
      ]);

      await setStatus(members[0]!, 'removed', 'Left the club');

      const { rows } = await db.pool.query<{ outcome: string }>(
        'select outcome::text from public.attendance_records where membership_id = $1',
        [members[0]!.membershipId],
      );
      expect(rows[0]!.outcome).toBe('no_show');
    });

    it('does nothing to a canceled match', async () => {
      await join(members[0]!);
      await db.pool.query(
        `update public.matches
            set status = 'canceled', canceled_at = now(), cancellation_reason = 'Waterlogged'
          where id = $1`,
        [match],
      );

      await setStatus(members[0]!, 'removed', 'Left the club');

      expect((await signupStatus(members[0]!))!.status).toBe('confirmed');
    });

    it('does not run on reactivation', async () => {
      await join(members[0]!);
      await setStatus(members[0]!, 'suspended');
      await setStatus(members[0]!, 'active', null);

      // Reactivation restores access, not the spot. Silently re-seating them
      // could push the match past capacity, and their place may well have gone
      // to somebody on the waitlist.
      expect((await signupStatus(members[0]!))!.status).toBe('not_selected');
      expect(await confirmedCount()).toBe(0);
    });

    it('lets a reactivated member sign up again', async () => {
      await join(members[0]!);
      await setStatus(members[0]!, 'suspended');
      await setStatus(members[0]!, 'active', null);

      await join(members[0]!);

      expect((await signupStatus(members[0]!))!.status).toBe('confirmed');
    });

    it('stops them signing up while suspended', async () => {
      await setStatus(members[0]!, 'suspended');

      const error = await expectDatabaseError(() => join(members[0]!));
      expect(error.message).toContain('MEMBERSHIP_REQUIRED');
    });
  });

  // ══ Published rosters and teams ══════════════════════════════════════════

  describe('when the roster and teams have been published', () => {
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

    it('advances the roster revision', async () => {
      await join(members[0]!);
      await join(members[1]!);
      await publishRosterAndTeams();
      const before = await revisions();

      await setStatus(members[0]!, 'removed', 'Left the club');

      expect((await revisions()).roster_revision).toBe(before.roster_revision + 1);
    });

    it('advances the team revision exactly once', async () => {
      await join(members[0]!);
      await join(members[1]!);
      await publishRosterAndTeams();
      const before = await revisions();

      await setStatus(members[0]!, 'removed', 'Left the club');

      expect((await revisions()).team_revision).toBe(before.team_revision + 1);
    });

    it('takes them out of the published teams the other players can see', async () => {
      await join(members[0]!);
      await join(members[1]!);
      await publishRosterAndTeams();

      await setStatus(members[0]!, 'removed', 'Left the club');

      const rows = await callAs<{ membership_id: string }>(
        members[1]!.user,
        'select membership_id from public.match_published_teams($1)',
        [match],
      );
      expect(rows.map((r) => r.membership_id)).not.toContain(members[0]!.membershipId);
    });

    it('tells the remaining players once that the teams changed', async () => {
      await join(members[0]!);
      await join(members[1]!);
      await publishRosterAndTeams();

      await setStatus(members[0]!, 'removed', 'Left the club');

      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.notifications
          where match_id = $1 and type = 'teams_changed' and recipient_user_id = $2`,
        [match, members[1]!.user.id],
      );
      expect(rows[0]!.n).toBe('1');
    });

    it('sends the removed member no team notification', async () => {
      await join(members[0]!);
      await join(members[1]!);
      await publishRosterAndTeams();

      await setStatus(members[0]!, 'removed', 'Left the club');

      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.notifications
          where match_id = $1 and type = 'teams_changed' and recipient_user_id = $2`,
        [match, members[0]!.user.id],
      );
      expect(rows[0]!.n).toBe('0');
    });

    it('drops their draft team assignment', async () => {
      await join(members[0]!);
      await join(members[1]!);
      await publishRosterAndTeams();

      await setStatus(members[0]!, 'removed', 'Left the club');

      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.match_team_assignments
          where match_id = $1 and membership_id = $2`,
        [match, members[0]!.membershipId],
      );
      expect(rows[0]!.n).toBe('0');
    });
  });

  // ══ Cross-league ═════════════════════════════════════════════════════════

  describe('cross-league isolation', () => {
    it('leaves their membership of another league alone', async () => {
      // `multiLeaguePlayer` belongs to both seeded leagues.
      const { rows: before } = await db.pool.query<{ id: string; league_id: string }>(
        `select id, league_id from public.league_memberships where user_id = $1`,
        [SEED_USERS.multiLeaguePlayer.id],
      );
      const fives = before.find((r) => r.league_id === SEED_LEAGUES.weeknightFives)!;
      const other = before.find((r) => r.league_id !== SEED_LEAGUES.weeknightFives)!;

      await callAs(admin, `select public.set_membership_status($1, 'removed', 'Left the club')`, [
        fives.id,
      ]);

      const { rows } = await db.pool.query<{ status: string }>(
        'select status from public.league_memberships where id = $1',
        [other.id],
      );
      expect(rows[0]!.status).toBe('active');
    });

    it('leaves their signups in another league alone', async () => {
      const { rows: memberships } = await db.pool.query<{ id: string; league_id: string }>(
        `select id, league_id from public.league_memberships where user_id = $1`,
        [SEED_USERS.multiLeaguePlayer.id],
      );
      const fives = memberships.find((r) => r.league_id === SEED_LEAGUES.weeknightFives)!;

      // The RMVFC match selects by administrator approval.
      await callAs(SEED_USERS.multiLeaguePlayer, 'select public.request_spot($1)', [
        SEED_MATCHES.rmvfcOpen,
      ]);
      await callAs(admin, `select public.set_membership_status($1, 'removed', 'Left the club')`, [
        fives.id,
      ]);

      const { rows } = await db.pool.query<{ status: string }>(
        `select status from public.match_signups where match_id = $1 and membership_id <> $2`,
        [SEED_MATCHES.rmvfcOpen, fives.id],
      );
      expect(rows.every((r) => r.status !== 'not_selected')).toBe(true);
    });
  });
});

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
 * Phase 5 — cancellation, and what happens to the spot it frees.
 *
 * `fivesOpen` (Weeknight 5v5) is first-come with **automatic** promotion;
 * `rmvfcOpen` (RMVFC) is administrator-approval with **administrator-controlled**
 * promotion. The two seeded matches carry the two waitlist modes, which is what
 * makes the difference between them testable without reconfiguring anything.
 */
describe('cancellation and promotion', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  async function setCapacity(matchId: string, capacity: number) {
    await db.pool.query(
      'update public.matches set capacity = $2, min_players = 1 where id = $1',
      [matchId, capacity],
    );
  }

  async function join(user: SeedUser, matchId: string) {
    return asUserCommitting(db, user, async (client) => {
      const result = await client.query<{ status: string; waitlist_position: number | null }>(
        'select * from public.join_match($1)',
        [matchId],
      );
      return result.rows[0];
    });
  }

  async function cancel(user: SeedUser, matchId: string, reason: string | null = null) {
    return asUserCommitting(db, user, async (client) => {
      const result = await client.query<{ status: string; waitlist_position: number | null }>(
        'select * from public.cancel_spot($1, $2)',
        [matchId, reason],
      );
      return result.rows[0];
    });
  }

  async function signupOf(matchId: string, membershipId: string) {
    const { rows } = await db.pool.query<{
      status: string;
      waitlist_position: number | null;
      canceled_at: string | null;
      cancellation_reason: string | null;
    }>(
      `select status, waitlist_position, canceled_at, cancellation_reason
         from public.match_signups where match_id = $1 and membership_id = $2`,
      [matchId, membershipId],
    );
    return rows[0] ?? null;
  }

  async function confirmedCount(matchId: string) {
    const { rows } = await db.pool.query<{ count: number }>(
      'select public.match_confirmed_count($1) as count',
      [matchId],
    );
    return rows[0]?.count ?? 0;
  }

  async function waitlist(matchId: string) {
    const { rows } = await db.pool.query<{ waitlist_position: number; membership_id: string }>(
      `select waitlist_position, membership_id from public.match_signups
        where match_id = $1 and status = 'waitlisted' order by waitlist_position`,
      [matchId],
    );
    return rows;
  }

  async function notificationTypes(matchId: string) {
    const { rows } = await db.pool.query<{ type: string; count: string }>(
      `select type::text, count(*)::text as count from public.notifications
        where match_id = $1 group by type order by type`,
      [matchId],
    );
    return rows;
  }

  /** Fills a first-come match to capacity and builds a waitlist behind it. */
  async function seatAndQueue(capacity: number, total: number): Promise<ExtraMember[]> {
    await setCapacity(SEED_MATCHES.fivesOpen, capacity);
    const members = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, total);
    for (const member of members) {
      await join(member.user, SEED_MATCHES.fivesOpen);
    }
    return members;
  }

  // ── Classification ───────────────────────────────────────────────────────

  describe('on-time and late classification', () => {
    it('records an on-time cancellation as canceled', async () => {
      const members = await seatAndQueue(2, 2);
      const outcome = await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);

      expect(outcome).toEqual({ status: 'canceled', waitlist_position: null });
    });

    it('records a cancellation after the cutoff as withdrawn_late', async () => {
      const members = await seatAndQueue(2, 2);
      await db.pool.query(
        `update public.matches set cancellation_cutoff_at = now() - interval '1 hour'
          where id = $1`,
        [SEED_MATCHES.fivesOpen],
      );

      const outcome = await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);
      expect(outcome?.status).toBe('withdrawn_late');
    });

    it('treats the exact cutoff instant as on time', async () => {
      // `now()` is transaction-start time, so no two transactions can be made
      // to share an instant and the boundary cannot be hit behaviourally
      // without racing the clock. The convention is asserted directly instead:
      // the classification is a strict `>`, and a strict `>` is false at
      // equality — so cancelling *at* the cutoff is on time.
      const { rows } = await db.pool.query<{ src: string }>(
        `select prosrc as src from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'cancel_spot'`,
      );
      expect(rows[0]?.src).toContain('now() > v_match.cancellation_cutoff_at');

      const { rows: boundary } = await db.pool.query<{ late_at_equality: boolean }>(
        `select (timestamptz '2026-06-01 19:00:00Z' > timestamptz '2026-06-01 19:00:00Z')
                  as late_at_equality`,
      );
      expect(boundary[0]?.late_at_equality).toBe(false);

      // And the two unambiguous sides behave accordingly.
      const members = await seatAndQueue(2, 2);
      await db.pool.query(
        `update public.matches set cancellation_cutoff_at = now() + interval '1 hour'
          where id = $1`,
        [SEED_MATCHES.fivesOpen],
      );
      expect((await cancel(members[0]!.user, SEED_MATCHES.fivesOpen))?.status).toBe('canceled');

      await db.pool.query(
        `update public.matches set cancellation_cutoff_at = now() - interval '1 microsecond'
          where id = $1`,
        [SEED_MATCHES.fivesOpen],
      );
      expect((await cancel(members[1]!.user, SEED_MATCHES.fivesOpen))?.status).toBe(
        'withdrawn_late',
      );
    });

    it('never marks a waitlisted withdrawal late, whatever the clock says', async () => {
      const members = await seatAndQueue(2, 4);
      await db.pool.query(
        `update public.matches set cancellation_cutoff_at = now() - interval '1 day'
          where id = $1`,
        [SEED_MATCHES.fivesOpen],
      );

      // members[2] is waitlisted. The late label exists because somebody the
      // match was counting on dropped out; nobody was counting on them.
      const outcome = await cancel(members[2]!.user, SEED_MATCHES.fivesOpen);
      expect(outcome?.status).toBe('canceled');
    });

    it('classifies from the database clock, not from anything a caller sends', async () => {
      const members = await seatAndQueue(2, 2);
      await db.pool.query(
        `update public.matches set cancellation_cutoff_at = now() - interval '1 hour'
          where id = $1`,
        [SEED_MATCHES.fivesOpen],
      );

      // cancel_spot takes exactly two parameters: the match and an optional
      // reason. There is no argument through which "on time" could be argued.
      const { rows } = await db.pool.query<{ args: string }>(
        `select pg_get_function_identity_arguments(p.oid) as args
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'cancel_spot'`,
      );
      expect(rows[0]?.args).toBe('p_match_id uuid, p_reason text');

      const outcome = await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);
      expect(outcome?.status).toBe('withdrawn_late');
    });

    it('stores the timestamp and reason it was given', async () => {
      const members = await seatAndQueue(2, 2);
      await cancel(members[0]!.user, SEED_MATCHES.fivesOpen, 'Injured');

      const row = await signupOf(SEED_MATCHES.fivesOpen, members[0]!.membershipId);
      expect(row?.canceled_at).not.toBeNull();
      expect(row?.cancellation_reason).toBe('Injured');
    });

    it('never records a no-show', async () => {
      const members = await seatAndQueue(2, 2);
      await db.pool.query(
        `update public.matches set cancellation_cutoff_at = now() - interval '1 hour'
          where id = $1`,
        [SEED_MATCHES.fivesOpen],
      );
      await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);

      // A late withdrawal is a withdrawal after the cutoff and nothing more.
      // Whether somebody failed to turn up is an attendance judgement Phase 7
      // owns, and no Phase 5 path may pre-empt it.
      const { rows } = await db.pool.query<{ blob: string }>(
        `select coalesce(string_agg(title || ' ' || body, ' '), '') as blob
           from public.notifications where match_id = $1`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows[0]?.blob.toLowerCase()).not.toContain('no-show');
      expect(rows[0]?.blob.toLowerCase()).not.toContain('no show');
    });
  });

  // ── Capacity ─────────────────────────────────────────────────────────────

  describe('capacity release', () => {
    it('stops a canceled signup consuming capacity', async () => {
      const members = await seatAndQueue(3, 3);
      expect(await confirmedCount(SEED_MATCHES.fivesOpen)).toBe(3);

      await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);
      // No waitlist behind them, so the count simply drops.
      expect(await confirmedCount(SEED_MATCHES.fivesOpen)).toBe(2);
    });

    it('excludes both cancellation statuses from the capacity definition', async () => {
      const { rows } = await db.pool.query<{ status: string; consumes: boolean }>(
        `select s::text as status, public.signup_consumes_capacity(s) as consumes
           from unnest(enum_range(null::public.signup_status)) s
          where s in ('canceled', 'withdrawn_late')`,
      );
      expect(rows.every((row) => row.consumes === false)).toBe(true);
    });

    it('is idempotent: cancelling twice releases one spot and promotes once', async () => {
      const members = await seatAndQueue(2, 4);

      const first = await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);
      const second = await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);
      const third = await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);

      expect(second).toEqual(first);
      expect(third).toEqual(first);
      expect(await confirmedCount(SEED_MATCHES.fivesOpen)).toBe(2);

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications
          where match_id = $1 and type in ('cancellation_receipt', 'waitlist_promotion')`,
        [SEED_MATCHES.fivesOpen],
      );
      // One receipt, one promotion. Not three of each.
      expect(rows[0]?.count).toBe('2');
    });

    it('refuses to cancel a signup that holds nothing', async () => {
      await asUserCommitting(db, SEED_USERS.multiLeaguePlayer, (client) =>
        client.query('select * from public.mark_unavailable($1)', [SEED_MATCHES.fivesOpen]),
      );

      const error = await expectDatabaseError(() =>
        cancel(SEED_USERS.multiLeaguePlayer, SEED_MATCHES.fivesOpen),
      );
      expect(error.message).toContain('SIGNUP_DECISION_INVALID');
    });

    it('refuses a player with no signup at all', async () => {
      const error = await expectDatabaseError(() =>
        cancel(SEED_USERS.multiLeaguePlayer, SEED_MATCHES.fivesOpen),
      );
      expect(error.message).toContain('NOT_AUTHORIZED');
    });

    it('refuses a non-member and answers as if the match did not exist', async () => {
      const error = await expectDatabaseError(() =>
        cancel(SEED_USERS.outsider, SEED_MATCHES.fivesOpen),
      );
      expect(error.message).toContain('MEMBERSHIP_REQUIRED');
    });
  });

  // ── Automatic promotion ──────────────────────────────────────────────────

  describe('automatic promotion', () => {
    it('promotes the first waitlisted player when a confirmed player cancels', async () => {
      const members = await seatAndQueue(2, 5);
      const before = await waitlist(SEED_MATCHES.fivesOpen);
      expect(before.map((row) => row.membership_id)).toEqual([
        members[2]!.membershipId,
        members[3]!.membershipId,
        members[4]!.membershipId,
      ]);

      await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);

      expect(
        (await signupOf(SEED_MATCHES.fivesOpen, members[2]!.membershipId))?.status,
      ).toBe('confirmed');
      expect(await confirmedCount(SEED_MATCHES.fivesOpen)).toBe(2);
    });

    it('compacts the remaining waitlist to 1..N', async () => {
      const members = await seatAndQueue(2, 5);
      await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);

      expect(await waitlist(SEED_MATCHES.fivesOpen)).toEqual([
        { waitlist_position: 1, membership_id: members[3]!.membershipId },
        { waitlist_position: 2, membership_id: members[4]!.membershipId },
      ]);
    });

    it('clears the promoted player’s waitlist position', async () => {
      const members = await seatAndQueue(2, 4);
      await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);

      const promoted = await signupOf(SEED_MATCHES.fivesOpen, members[2]!.membershipId);
      expect(promoted).toMatchObject({ status: 'confirmed', waitlist_position: null });
    });

    it('notifies the promoted player exactly once', async () => {
      const members = await seatAndQueue(2, 4);
      await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);

      const { rows } = await db.pool.query<{ recipient_user_id: string; count: string }>(
        `select recipient_user_id, count(*)::text as count from public.notifications
          where match_id = $1 and type = 'waitlist_promotion'
          group by recipient_user_id`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.recipient_user_id).toBe(members[2]!.user.id);
      expect(rows[0]?.count).toBe('1');
    });

    it('skips a suspended candidate and promotes the next eligible one', async () => {
      const members = await seatAndQueue(2, 5);
      await db.pool.query(
        `update public.league_memberships set status = 'suspended' where id = $1`,
        [members[2]!.membershipId],
      );

      await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);

      // F-09 says the first *eligible* player is promoted.
      expect(
        (await signupOf(SEED_MATCHES.fivesOpen, members[2]!.membershipId))?.status,
      ).toBe('waitlisted');
      expect(
        (await signupOf(SEED_MATCHES.fivesOpen, members[3]!.membershipId))?.status,
      ).toBe('confirmed');
    });

    it('leaves a skipped candidate on the waitlist rather than dropping them', async () => {
      const members = await seatAndQueue(2, 4);
      await db.pool.query(
        `update public.league_memberships set status = 'suspended' where id = $1`,
        [members[2]!.membershipId],
      );
      await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);

      // They may be reinstated later; silently removing them would be a
      // punishment nothing in the product describes.
      const skipped = await signupOf(SEED_MATCHES.fivesOpen, members[2]!.membershipId);
      expect(skipped?.status).toBe('waitlisted');
      expect(skipped?.waitlist_position).toBe(1);
    });

    it('skips a candidate who has not accepted the current guidelines', async () => {
      // RMVFC requires acceptance; switch it to first-come + automatic so a
      // cancellation promotes there.
      await db.pool.query(
        `update public.matches
            set selection_mode = 'first_come', waitlist_mode = 'automatic',
                capacity = 2, min_players = 1
          where id = $1`,
        [SEED_MATCHES.rmvfcOpen],
      );
      const accepted = await createExtraMembers(db, SEED_LEAGUES.rmvfc, 3, 'ok');
      const blocked = await createExtraMembers(db, SEED_LEAGUES.rmvfc, 1, 'blocked');

      // Two seated, then the blocked member joins next so they legitimately
      // hold waitlist position 1, then one more behind them.
      await join(accepted[0]!.user, SEED_MATCHES.rmvfcOpen);
      await join(accepted[1]!.user, SEED_MATCHES.rmvfcOpen);
      await join(blocked[0]!.user, SEED_MATCHES.rmvfcOpen);
      await join(accepted[2]!.user, SEED_MATCHES.rmvfcOpen);

      // Only now does their acceptance lapse — exactly the situation the
      // promotion-time re-check exists for.
      await db.pool.query(
        `delete from public.guideline_acceptances where membership_id = $1`,
        [blocked[0]!.membershipId],
      );

      await cancel(accepted[0]!.user, SEED_MATCHES.rmvfcOpen);

      expect(
        (await signupOf(SEED_MATCHES.rmvfcOpen, blocked[0]!.membershipId))?.status,
      ).toBe('waitlisted');
      expect(
        (await signupOf(SEED_MATCHES.rmvfcOpen, accepted[2]!.membershipId))?.status,
      ).toBe('confirmed');
    });

    it('promotes nobody when the waitlist is empty', async () => {
      const members = await seatAndQueue(3, 3);
      await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);

      expect(await confirmedCount(SEED_MATCHES.fivesOpen)).toBe(2);
      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications
          where match_id = $1 and type = 'waitlist_promotion'`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows[0]?.count).toBe('0');
    });

    it('promotes nobody when a waitlisted player withdraws', async () => {
      const members = await seatAndQueue(2, 5);
      await cancel(members[3]!.user, SEED_MATCHES.fivesOpen);

      // No capacity was released, so there is nothing to fill.
      expect(await confirmedCount(SEED_MATCHES.fivesOpen)).toBe(2);
      expect(await waitlist(SEED_MATCHES.fivesOpen)).toEqual([
        { waitlist_position: 1, membership_id: members[2]!.membershipId },
        { waitlist_position: 2, membership_id: members[4]!.membershipId },
      ]);

      const types = await notificationTypes(SEED_MATCHES.fivesOpen);
      expect(types.some((row) => row.type === 'waitlist_promotion')).toBe(false);
    });
  });

  // ── Administrator-controlled ─────────────────────────────────────────────

  describe('administrator-controlled promotion', () => {
    let members: ExtraMember[];

    beforeEach(async () => {
      // RMVFC is admin_approval + admin_controlled in the seed. Make it
      // first-come so players can seat themselves, keeping the waitlist mode.
      await db.pool.query(
        `update public.matches
            set selection_mode = 'first_come', capacity = 2, min_players = 1
          where id = $1`,
        [SEED_MATCHES.rmvfcOpen],
      );
      members = await createExtraMembers(db, SEED_LEAGUES.rmvfc, 5);
      for (const member of members) {
        await join(member.user, SEED_MATCHES.rmvfcOpen);
      }
    });

    async function promote(
      user: SeedUser = SEED_USERS.rmvfcAdmin,
      membershipId: string | null = null,
      reason: string | null = null,
    ) {
      return asUserCommitting(db, user, async (client) => {
        const result = await client.query<{ status: string }>(
          'select * from public.promote_waitlisted_player($1, $2, $3)',
          [SEED_MATCHES.rmvfcOpen, membershipId, reason],
        );
        return result.rows[0];
      });
    }

    it('promotes nobody automatically when a confirmed player cancels', async () => {
      await cancel(members[0]!.user, SEED_MATCHES.rmvfcOpen);

      expect(await confirmedCount(SEED_MATCHES.rmvfcOpen)).toBe(1);
      expect((await waitlist(SEED_MATCHES.rmvfcOpen)).length).toBe(3);
    });

    it('alerts the administrator that a spot opened', async () => {
      await cancel(members[0]!.user, SEED_MATCHES.rmvfcOpen);

      const { rows } = await db.pool.query<{ recipient_user_id: string; count: string }>(
        `select recipient_user_id, count(*)::text as count from public.notifications
          where match_id = $1 and type = 'replacement_needed' group by recipient_user_id`,
        [SEED_MATCHES.rmvfcOpen],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.recipient_user_id).toBe(SEED_USERS.rmvfcAdmin.id);
    });

    it('does not alert the administrator when a waitlisted player withdraws', async () => {
      await cancel(members[3]!.user, SEED_MATCHES.rmvfcOpen);

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications
          where match_id = $1 and type = 'replacement_needed'`,
        [SEED_MATCHES.rmvfcOpen],
      );
      // No capacity was released, so there is no vacancy to fill.
      expect(rows[0]?.count).toBe('0');
    });

    it('recommends the first eligible waitlisted player, to the administrator only', async () => {
      await cancel(members[0]!.user, SEED_MATCHES.rmvfcOpen);

      const asAdmin = await asUser(db, SEED_USERS.rmvfcAdmin, async (client) => {
        const result = await client.query<{
          open_spots: number;
          recommended_membership_id: string | null;
        }>('select * from public.match_replacement_state($1)', [SEED_MATCHES.rmvfcOpen]);
        return result.rows[0];
      });
      expect(asAdmin).toMatchObject({
        open_spots: 1,
        recommended_membership_id: members[2]!.membershipId,
      });

      const asPlayer = await asUser(db, members[1]!.user, async (client) => {
        const result = await client.query('select * from public.match_replacement_state($1)', [
          SEED_MATCHES.rmvfcOpen,
        ]);
        return result.rows;
      });
      expect(asPlayer).toEqual([]);
    });

    it('promotes the recommendation when no target is named', async () => {
      await cancel(members[0]!.user, SEED_MATCHES.rmvfcOpen);
      expect(await promote()).toEqual({ status: 'confirmed', waitlist_position: null });

      expect(
        (await signupOf(SEED_MATCHES.rmvfcOpen, members[2]!.membershipId))?.status,
      ).toBe('confirmed');
      expect(await waitlist(SEED_MATCHES.rmvfcOpen)).toEqual([
        { waitlist_position: 1, membership_id: members[3]!.membershipId },
        { waitlist_position: 2, membership_id: members[4]!.membershipId },
      ]);
    });

    it('refuses to promote out of order without a reason', async () => {
      await cancel(members[0]!.user, SEED_MATCHES.rmvfcOpen);

      const error = await expectDatabaseError(() =>
        promote(SEED_USERS.rmvfcAdmin, members[4]!.membershipId),
      );
      expect(error.message).toContain('SIGNUP_DECISION_INVALID');
    });

    it('promotes out of order with a reason, and audits it', async () => {
      await cancel(members[0]!.user, SEED_MATCHES.rmvfcOpen);
      await promote(SEED_USERS.rmvfcAdmin, members[4]!.membershipId, 'Only keeper available');

      expect(
        (await signupOf(SEED_MATCHES.rmvfcOpen, members[4]!.membershipId))?.status,
      ).toBe('confirmed');

      const { rows } = await db.pool.query<{
        reason: string;
        after_data: Record<string, unknown>;
      }>(
        `select reason, after_data from public.audit_events
          where entity_id = $1 and action = 'roster.promoted'`,
        [SEED_MATCHES.rmvfcOpen],
      );
      expect(rows[0]?.reason).toBe('Only keeper available');
      expect(rows[0]?.after_data['followed_recommendation']).toBe(false);
    });

    it('keeps the override reason out of the promoted player’s notification', async () => {
      await cancel(members[0]!.user, SEED_MATCHES.rmvfcOpen);
      await promote(SEED_USERS.rmvfcAdmin, members[4]!.membershipId, 'SECRETOVERRIDE');

      const { rows } = await db.pool.query<{ blob: string }>(
        `select coalesce(string_agg(title || ' ' || body, ' '), '') as blob
           from public.notifications where match_id = $1`,
        [SEED_MATCHES.rmvfcOpen],
      );
      expect(rows[0]?.blob).not.toContain('SECRETOVERRIDE');
    });

    it('refuses to exceed capacity', async () => {
      // Nobody has cancelled, so the roster is full.
      const error = await expectDatabaseError(() => promote());
      expect(error.message).toContain('CAPACITY_EXCEEDED');
    });

    it('refuses a player and a cross-league administrator', async () => {
      await cancel(members[0]!.user, SEED_MATCHES.rmvfcOpen);

      for (const user of [members[1]!.user, SEED_USERS.fivesAdmin]) {
        const error = await expectDatabaseError(() => promote(user));
        expect(error.message).toContain('NOT_LEAGUE_ADMIN');
      }
    });

    it('refuses a target who is not on the waitlist', async () => {
      await cancel(members[0]!.user, SEED_MATCHES.rmvfcOpen);

      const error = await expectDatabaseError(() =>
        promote(SEED_USERS.rmvfcAdmin, members[1]!.membershipId, 'Already playing'),
      );
      expect(error.message).toContain('WAITLIST_CONFLICT');
    });

    it('refuses a membership from another league as if it did not exist', async () => {
      await cancel(members[0]!.user, SEED_MATCHES.rmvfcOpen);

      const error = await expectDatabaseError(() =>
        promote(SEED_USERS.rmvfcAdmin, SEED_MEMBERSHIPS.fivesMultiLeaguePlayer, 'Cross league'),
      );
      expect(error.message).toContain('WAITLIST_CONFLICT');
    });

    it('refuses a suspended target', async () => {
      await cancel(members[0]!.user, SEED_MATCHES.rmvfcOpen);
      await db.pool.query(
        `update public.league_memberships set status = 'suspended' where id = $1`,
        [members[3]!.membershipId],
      );

      const error = await expectDatabaseError(() =>
        promote(SEED_USERS.rmvfcAdmin, members[3]!.membershipId, 'Wanted them anyway'),
      );
      expect(error.message).toContain('MEMBERSHIP_INACTIVE');
    });
  });

  // ── Roster revision ──────────────────────────────────────────────────────

  describe('roster revision', () => {
    it('does not advance for a first-come match, which never publishes', async () => {
      const members = await seatAndQueue(2, 4);
      await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);

      const { rows } = await db.pool.query<{ roster_revision: number }>(
        'select roster_revision from public.matches where id = $1',
        [SEED_MATCHES.fivesOpen],
      );
      // F-06 makes its roster authoritative on join; there is nothing published
      // to revise.
      expect(rows[0]?.roster_revision).toBe(0);
    });

    it('does not advance before the roster has been finalized', async () => {
      await db.pool.query(
        `update public.matches set selection_mode = 'first_come', capacity = 2, min_players = 1
          where id = $1`,
        [SEED_MATCHES.rmvfcOpen],
      );
      const members = await createExtraMembers(db, SEED_LEAGUES.rmvfc, 4);
      for (const member of members) {
        await join(member.user, SEED_MATCHES.rmvfcOpen);
      }
      await cancel(members[0]!.user, SEED_MATCHES.rmvfcOpen);

      const { rows } = await db.pool.query<{ roster_revision: number }>(
        'select roster_revision from public.matches where id = $1',
        [SEED_MATCHES.rmvfcOpen],
      );
      expect(rows[0]?.roster_revision).toBe(0);
    });

    it('advances once for a cancellation and its promotion after publication', async () => {
      await db.pool.query(
        `update public.matches set selection_mode = 'first_come', capacity = 2,
                                   min_players = 1, waitlist_mode = 'automatic'
          where id = $1`,
        [SEED_MATCHES.rmvfcOpen],
      );
      const members = await createExtraMembers(db, SEED_LEAGUES.rmvfc, 4);
      for (const member of members) {
        await join(member.user, SEED_MATCHES.rmvfcOpen);
      }
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.finalize_roster($1)', [SEED_MATCHES.rmvfcOpen]),
      );

      await cancel(members[0]!.user, SEED_MATCHES.rmvfcOpen);

      const { rows } = await db.pool.query<{ roster_revision: number }>(
        'select roster_revision from public.matches where id = $1',
        [SEED_MATCHES.rmvfcOpen],
      );
      // One domain transaction — the withdrawal and the replacement — is one
      // visible roster change.
      expect(rows[0]?.roster_revision).toBe(2);
    });

    it('does not advance again when the same cancellation is retried', async () => {
      await db.pool.query(
        `update public.matches set selection_mode = 'first_come', capacity = 2,
                                   min_players = 1, waitlist_mode = 'automatic'
          where id = $1`,
        [SEED_MATCHES.rmvfcOpen],
      );
      const members = await createExtraMembers(db, SEED_LEAGUES.rmvfc, 4);
      for (const member of members) {
        await join(member.user, SEED_MATCHES.rmvfcOpen);
      }
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.finalize_roster($1)', [SEED_MATCHES.rmvfcOpen]),
      );

      await cancel(members[0]!.user, SEED_MATCHES.rmvfcOpen);
      await cancel(members[0]!.user, SEED_MATCHES.rmvfcOpen);
      await cancel(members[0]!.user, SEED_MATCHES.rmvfcOpen);

      const { rows } = await db.pool.query<{ roster_revision: number }>(
        'select roster_revision from public.matches where id = $1',
        [SEED_MATCHES.rmvfcOpen],
      );
      expect(rows[0]?.roster_revision).toBe(2);
    });

    it('leaves republication with nothing to announce afterwards', async () => {
      await db.pool.query(
        `update public.matches set selection_mode = 'first_come', capacity = 2,
                                   min_players = 1, waitlist_mode = 'automatic'
          where id = $1`,
        [SEED_MATCHES.rmvfcOpen],
      );
      const members = await createExtraMembers(db, SEED_LEAGUES.rmvfc, 4);
      for (const member of members) {
        await join(member.user, SEED_MATCHES.rmvfcOpen);
      }
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.finalize_roster($1)', [SEED_MATCHES.rmvfcOpen]),
      );
      await cancel(members[0]!.user, SEED_MATCHES.rmvfcOpen);

      const before = await db.pool.query<{ count: string }>(
        'select count(*)::text as count from public.notifications where match_id = $1',
        [SEED_MATCHES.rmvfcOpen],
      );

      // The cancellation already synced `published_status` for the rows it
      // touched, so finalize_roster() sees a clean roster and says nothing.
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select public.finalize_roster($1)', [SEED_MATCHES.rmvfcOpen]),
      );

      const after = await db.pool.query<{ count: string }>(
        'select count(*)::text as count from public.notifications where match_id = $1',
        [SEED_MATCHES.rmvfcOpen],
      );
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    });
  });

  // ── Notifications, audit and privacy ─────────────────────────────────────

  describe('notifications and privacy', () => {
    it('sends the canceller a receipt', async () => {
      const members = await seatAndQueue(2, 2);
      await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);

      const { rows } = await db.pool.query<{ recipient_user_id: string; body: string }>(
        `select recipient_user_id, body from public.notifications
          where match_id = $1 and type = 'cancellation_receipt'`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.recipient_user_id).toBe(members[0]!.user.id);
    });

    it('alerts the administrator only for a late cancellation', async () => {
      const members = await seatAndQueue(2, 2);
      await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);

      const alerts = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications
          where match_id = $1 and type = 'late_cancellation'`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(alerts.rows[0]?.count).toBe('0');

      await db.pool.query(
        `update public.matches set cancellation_cutoff_at = now() - interval '1 hour'
          where id = $1`,
        [SEED_MATCHES.fivesOpen],
      );
      await cancel(members[1]!.user, SEED_MATCHES.fivesOpen);

      const withRecipient = await db.pool.query<{ count: string; recipient_user_id: string }>(
        `select count(*)::text as count, max(recipient_user_id::text) as recipient_user_id
           from public.notifications where match_id = $1 and type = 'late_cancellation'`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(withRecipient.rows[0]?.count).toBe('1');
      expect(withRecipient.rows[0]?.recipient_user_id).toBe(SEED_USERS.fivesAdmin.id);
    });

    it('never puts the cancellation reason in any notification', async () => {
      const members = await seatAndQueue(2, 3);
      await db.pool.query(
        `update public.matches set cancellation_cutoff_at = now() - interval '1 hour'
          where id = $1`,
        [SEED_MATCHES.fivesOpen],
      );
      await cancel(members[0]!.user, SEED_MATCHES.fivesOpen, 'CONFIDENTIALREASON');

      const { rows } = await db.pool.query<{ blob: string }>(
        `select coalesce(string_agg(title || ' ' || body || ' ' || deep_link, ' '), '') as blob
           from public.notifications`,
      );
      // Free text about a person, and these bodies are candidates for a lock
      // screen.
      expect(rows[0]?.blob).not.toContain('CONFIDENTIALREASON');
    });

    it('never puts the cancellation reason in an audit event', async () => {
      const members = await seatAndQueue(2, 2);
      await cancel(members[0]!.user, SEED_MATCHES.fivesOpen, 'CONFIDENTIALREASON');

      const { rows } = await db.pool.query<{
        after_data: Record<string, unknown>;
        reason: string | null;
      }>(
        `select after_data, reason from public.audit_events
          where entity_id = $1 and action = 'signup.canceled'`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.after_data['had_reason']).toBe(true);
      expect(JSON.stringify(rows[0])).not.toContain('CONFIDENTIALREASON');
    });

    it('audits the cancellation with the actor and the classification', async () => {
      const members = await seatAndQueue(2, 4);
      await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);

      const { rows } = await db.pool.query<{
        actor_user_id: string;
        after_data: Record<string, unknown>;
      }>(
        `select actor_user_id, after_data from public.audit_events
          where entity_id = $1 and action = 'signup.canceled'`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows[0]?.actor_user_id).toBe(members[0]!.user.id);
      expect(rows[0]?.after_data).toMatchObject({
        status: 'canceled',
        late: false,
        released_capacity: true,
        promoted_membership_id: members[2]!.membershipId,
      });
    });

    it('keeps another player’s cancellation reason unreadable', async () => {
      const members = await seatAndQueue(2, 3);
      await cancel(members[0]!.user, SEED_MATCHES.fivesOpen, 'CONFIDENTIALREASON');

      const rows = await asUser(db, members[1]!.user, async (client) => {
        const result = await client.query(
          'select cancellation_reason from public.match_signups where membership_id = $1',
          [members[0]!.membershipId],
        );
        return result.rows;
      });
      // The row itself is invisible, so there is no column to read.
      expect(rows).toEqual([]);
    });

    it('keeps the waitlist private through the cancellation flow', async () => {
      const members = await seatAndQueue(2, 5);
      await cancel(members[0]!.user, SEED_MATCHES.fivesOpen);

      const rows = await asUser(db, members[3]!.user, async (client) => {
        const result = await client.query<{ waitlist_position: number | null }>(
          'select waitlist_position from public.match_signups',
        );
        return result.rows;
      });
      // Their own row only, and therefore their own position only.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.waitlist_position).toBe(1);
    });
  });
});

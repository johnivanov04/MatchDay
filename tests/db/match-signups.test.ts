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
  SEED_MATCHES,
  SEED_MEMBERSHIPS,
  SEED_USERS,
  type ExtraMember,
  type SeedUser,
  type TestDatabase,
} from './helpers/harness';

/**
 * Phase 4 — signup, roster and waitlist.
 *
 * Two seeded matches carry the two selection modes:
 *   * `fivesOpen`  — Weeknight 5v5, first_come, capacity 10, guidelines are
 *     informational so nobody is blocked by them;
 *   * `rmvfcOpen`  — RMV Football Club, admin_approval, capacity 22, with a
 *     *required* guideline that only the multi-league player has accepted.
 * That difference is the tenancy property under test in the eligibility block.
 */
describe('match signups', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase('seeded');
  });

  afterEach(async () => {
    await db.drop();
  });

  /** Shrinks a match so a waitlist forms without inventing dozens of members. */
  // Capacity has a floor of 2 (`matches_capacity_range`), so the smallest
  // useful roster is two players and the waitlist starts at the third.
  async function setCapacity(matchId: string, capacity: number, minPlayers = 1) {
    await db.pool.query(
      'update public.matches set capacity = $2, min_players = $3 where id = $1',
      [matchId, capacity, minPlayers],
    );
  }

  async function join(user: { id: string; email: string }, matchId: string) {
    return asUserCommitting(db, user, async (client) => {
      const result = await client.query<{ status: string; waitlist_position: number | null }>(
        'select * from public.join_match($1)',
        [matchId],
      );
      return result.rows[0];
    });
  }

  async function statusOf(matchId: string, membershipId: string) {
    const { rows } = await db.pool.query<{ status: string; waitlist_position: number | null }>(
      'select status, waitlist_position from public.match_signups where match_id = $1 and membership_id = $2',
      [matchId, membershipId],
    );
    return rows[0] ?? null;
  }

  async function waitlistOrder(matchId: string): Promise<string[]> {
    const { rows } = await db.pool.query<{ membership_id: string }>(
      `select membership_id from public.match_signups
        where match_id = $1 and status = 'waitlisted' order by waitlist_position`,
      [matchId],
    );
    return rows.map((row) => row.membership_id);
  }

  // ── Schema and constraints ───────────────────────────────────────────────

  describe('schema', () => {
    it('allows exactly one signup per player per match', async () => {
      await join(SEED_USERS.multiLeaguePlayer, SEED_MATCHES.fivesOpen);

      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.match_signups (league_id, match_id, membership_id, status)
           values ($1, $2, $3, 'interested')`,
          [
            SEED_LEAGUES.weeknightFives,
            SEED_MATCHES.fivesOpen,
            SEED_MEMBERSHIPS.fivesMultiLeaguePlayer,
          ],
        ),
      );
      expect(error.code).toBe(PG_ERROR.uniqueViolation);
    });

    it('cannot represent a signup whose match and membership are in different leagues', async () => {
      // The membership belongs to Weeknight 5v5, the match to RMVFC. Both
      // composite foreign keys carry league_id, so neither league_id can be
      // chosen to satisfy both.
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.match_signups (league_id, match_id, membership_id, status)
           values ($1, $2, $3, 'confirmed')`,
          [SEED_LEAGUES.rmvfc, SEED_MATCHES.rmvfcOpen, SEED_MEMBERSHIPS.fivesMultiLeaguePlayer],
        ),
      );
      expect(error.code).toBe(PG_ERROR.foreignKeyViolation);
    });

    it('refuses a waitlist position on a status that is not waitlisted', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.match_signups
             (league_id, match_id, membership_id, status, waitlist_position)
           values ($1, $2, $3, 'confirmed', 1)`,
          [
            SEED_LEAGUES.weeknightFives,
            SEED_MATCHES.fivesOpen,
            SEED_MEMBERSHIPS.fivesMultiLeaguePlayer,
          ],
        ),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
    });

    it('requires a waitlist position when waitlisted', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.match_signups (league_id, match_id, membership_id, status)
           values ($1, $2, $3, 'waitlisted')`,
          [
            SEED_LEAGUES.weeknightFives,
            SEED_MATCHES.fivesOpen,
            SEED_MEMBERSHIPS.fivesMultiLeaguePlayer,
          ],
        ),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
    });

    it('refuses a waitlist position below one', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.match_signups
             (league_id, match_id, membership_id, status, waitlist_position)
           values ($1, $2, $3, 'waitlisted', 0)`,
          [
            SEED_LEAGUES.weeknightFives,
            SEED_MATCHES.fivesOpen,
            SEED_MEMBERSHIPS.fivesMultiLeaguePlayer,
          ],
        ),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
    });

    it('refuses two players at the same waitlist position', async () => {
      const members = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 2);
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.match_signups
             (league_id, match_id, membership_id, status, waitlist_position)
           values ($1, $2, $3, 'waitlisted', 1), ($1, $2, $4, 'waitlisted', 1)`,
          [
            SEED_LEAGUES.weeknightFives,
            SEED_MATCHES.fivesOpen,
            members[0]?.membershipId,
            members[1]?.membershipId,
          ],
        ),
      );
      expect(error.code).toBe(PG_ERROR.uniqueViolation);
    });

    it('refuses half-recorded selection metadata', async () => {
      const error = await expectDatabaseError(() =>
        db.pool.query(
          `insert into public.match_signups
             (league_id, match_id, membership_id, status, selected_by)
           values ($1, $2, $3, 'confirmed', $4)`,
          [
            SEED_LEAGUES.weeknightFives,
            SEED_MATCHES.fivesOpen,
            SEED_MEMBERSHIPS.fivesMultiLeaguePlayer,
            SEED_USERS.fivesAdmin.id,
          ],
        ),
      );
      expect(error.code).toBe(PG_ERROR.checkViolation);
    });

    it('keeps the Phase 5 cancellation statuses unreachable', async () => {
      for (const status of ['canceled', 'withdrawn_late']) {
        const error = await expectDatabaseError(() =>
          db.pool.query(
            `insert into public.match_signups
               (league_id, match_id, membership_id, status, canceled_at)
             values ($1, $2, $3, $4, now())`,
            [
              SEED_LEAGUES.weeknightFives,
              SEED_MATCHES.fivesOpen,
              SEED_MEMBERSHIPS.fivesMultiLeaguePlayer,
              status,
            ],
          ),
        );
        // Writing one would free a capacity slot with none of the cancellation
        // behaviour — no receipt, no promotion, no late classification.
        expect(error.message).toContain('SIGNUP_TRANSITION_INVALID');
      }
    });

    it('counts only confirmed players against capacity', async () => {
      const { rows } = await db.pool.query<{ status: string; consumes: boolean }>(
        `select s::text as status, public.signup_consumes_capacity(s) as consumes
           from unnest(enum_range(null::public.signup_status)) s order by s`,
      );

      const consuming = rows.filter((row) => row.consumes).map((row) => row.status);
      // `interested` must not consume: an admin_approval match would otherwise
      // report itself full before the administrator decided anything.
      expect(consuming).toEqual(['confirmed']);
    });
  });

  // ── Eligibility ──────────────────────────────────────────────────────────

  describe('eligibility', () => {
    async function eligibility(user: { id: string; email: string }, matchId: string) {
      return asUser(db, user, async (client) => {
        const result = await client.query<{ code: string }>(
          'select public.match_signup_eligibility($1) as code',
          [matchId],
        );
        return result.rows[0]?.code;
      });
    }

    it('accepts an active member with nothing outstanding', async () => {
      expect(await eligibility(SEED_USERS.multiLeaguePlayer, SEED_MATCHES.fivesOpen)).toBe(
        'ELIGIBLE',
      );
    });

    it('refuses a non-member, and tells them nothing about the match', async () => {
      expect(await eligibility(SEED_USERS.outsider, SEED_MATCHES.fivesOpen)).toBe(
        'MEMBERSHIP_REQUIRED',
      );
    });

    it('refuses pending, suspended and removed members', async () => {
      expect(await eligibility(SEED_USERS.pendingPlayer, SEED_MATCHES.fivesOpen)).toBe(
        'MEMBERSHIP_REQUIRED',
      );
      for (const user of [SEED_USERS.suspendedPlayer, SEED_USERS.removedPlayer]) {
        expect(await eligibility(user, SEED_MATCHES.rmvfcOpen)).toBe('MEMBERSHIP_REQUIRED');
      }
    });

    it('refuses a member who has not accepted the required guidelines', async () => {
      expect(await eligibility(SEED_USERS.rmvfcPlayer, SEED_MATCHES.rmvfcOpen)).toBe(
        'GUIDELINES_NOT_ACCEPTED',
      );
    });

    it('answers differently for the same person in two leagues', async () => {
      // RMVFC requires acceptance and this player has accepted; Weeknight 5v5's
      // guidelines are informational. Same person, two leagues, and the answer
      // depends only on the league — the tenancy property from 02 §8.
      expect(await eligibility(SEED_USERS.multiLeaguePlayer, SEED_MATCHES.rmvfcOpen)).toBe(
        'ELIGIBLE',
      );
      expect(await eligibility(SEED_USERS.multiLeaguePlayer, SEED_MATCHES.fivesOpen)).toBe(
        'ELIGIBLE',
      );

      // And a member of RMVFC who has not accepted is blocked there while a
      // member of the other league is not.
      expect(await eligibility(SEED_USERS.rmvfcPlayer, SEED_MATCHES.rmvfcOpen)).toBe(
        'GUIDELINES_NOT_ACCEPTED',
      );
    });

    it('answers a draft exactly as a match that does not exist', async () => {
      // Even for an active member of that very league: a MATCH_NOT_OPEN answer
      // would confirm the draft exists, which is what drafts are hidden from.
      expect(await eligibility(SEED_USERS.multiLeaguePlayer, SEED_MATCHES.rmvfcDraft)).toBe(
        'MEMBERSHIP_REQUIRED',
      );
    });

    it('refuses a canceled match', async () => {
      await asUserCommitting(db, SEED_USERS.fivesAdmin, (client) =>
        client.query('select public.cancel_match($1)', [SEED_MATCHES.fivesOpen]),
      );
      expect(await eligibility(SEED_USERS.multiLeaguePlayer, SEED_MATCHES.fivesOpen)).toBe(
        'MATCH_NOT_OPEN',
      );
    });

    it('refuses once the signup deadline has passed', async () => {
      await db.pool.query(
        `update public.matches
            set signup_closes_at = now() - interval '1 hour',
                priority_window_ends_at = null
          where id = $1`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(await eligibility(SEED_USERS.multiLeaguePlayer, SEED_MATCHES.fivesOpen)).toBe(
        'SIGNUP_CLOSED',
      );
    });

    it('answers an unknown match exactly as a league the caller is not in', async () => {
      const unknown = await eligibility(
        SEED_USERS.multiLeaguePlayer,
        'aaaaaaaa-aaaa-4aaa-8aaa-0000000000ff',
      );
      const otherLeague = await eligibility(SEED_USERS.rmvfcPlayer, SEED_MATCHES.fivesOpen);

      expect(unknown).toBe('MEMBERSHIP_REQUIRED');
      expect(unknown).toBe(otherLeague);
    });

    it('refuses an unauthenticated caller', async () => {
      const error = await expectDatabaseError(() =>
        asAnon(db, (client) =>
          client.query('select public.match_signup_eligibility($1)', [SEED_MATCHES.fivesOpen]),
        ),
      );
      expect(error.code).toBe(PG_ERROR.insufficientPrivilege);
    });
  });

  // ── First-come ───────────────────────────────────────────────────────────

  describe('first-come signup', () => {
    it('confirms immediately while spots remain', async () => {
      const outcome = await join(SEED_USERS.multiLeaguePlayer, SEED_MATCHES.fivesOpen);

      expect(outcome).toEqual({ status: 'confirmed', waitlist_position: null });
    });

    it('waitlists once capacity is reached, in arrival order', async () => {
      await setCapacity(SEED_MATCHES.fivesOpen, 2);
      const members = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 4);

      const outcomes = [];
      for (const member of members) {
        outcomes.push(await join(member.user, SEED_MATCHES.fivesOpen));
      }

      expect(outcomes).toEqual([
        { status: 'confirmed', waitlist_position: null },
        { status: 'confirmed', waitlist_position: null },
        { status: 'waitlisted', waitlist_position: 1 },
        { status: 'waitlisted', waitlist_position: 2 },
      ]);
    });

    it('is idempotent across repeated taps', async () => {
      const first = await join(SEED_USERS.multiLeaguePlayer, SEED_MATCHES.fivesOpen);
      const second = await join(SEED_USERS.multiLeaguePlayer, SEED_MATCHES.fivesOpen);
      const third = await join(SEED_USERS.multiLeaguePlayer, SEED_MATCHES.fivesOpen);

      expect(second).toEqual(first);
      expect(third).toEqual(first);

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.match_signups where match_id = $1`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('returns the same waitlist position on a repeated tap', async () => {
      await setCapacity(SEED_MATCHES.fivesOpen, 2);
      const members = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 3);

      await join(members[0]!.user, SEED_MATCHES.fivesOpen);
      await join(members[1]!.user, SEED_MATCHES.fivesOpen);
      const first = await join(members[2]!.user, SEED_MATCHES.fivesOpen);
      const again = await join(members[2]!.user, SEED_MATCHES.fivesOpen);

      expect(first).toEqual({ status: 'waitlisted', waitlist_position: 1 });
      expect(again).toEqual(first);
    });

    it('creates exactly one notification per outcome', async () => {
      await join(SEED_USERS.multiLeaguePlayer, SEED_MATCHES.fivesOpen);
      await join(SEED_USERS.multiLeaguePlayer, SEED_MATCHES.fivesOpen);

      const { rows } = await db.pool.query<{ type: string; count: string }>(
        `select type::text, count(*)::text as count from public.notifications
          where match_id = $1 group by type`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows).toEqual([{ type: 'signup_confirmed', count: '1' }]);
    });

    it('refuses on an administrator-approved match', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.multiLeaguePlayer, (client) =>
          client.query('select * from public.join_match($1)', [SEED_MATCHES.rmvfcOpen]),
        ),
      );
      expect(error.message).toContain('SIGNUP_MODE_MISMATCH');
    });

    it('refuses a player who has not accepted the guidelines', async () => {
      await db.pool.query(
        `update public.matches set selection_mode = 'first_come' where id = $1`,
        [SEED_MATCHES.rmvfcOpen],
      );
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.rmvfcPlayer, (client) =>
          client.query('select * from public.join_match($1)', [SEED_MATCHES.rmvfcOpen]),
        ),
      );
      expect(error.message).toContain('GUIDELINES_NOT_ACCEPTED');
    });
  });

  // ── "Can't play" ─────────────────────────────────────────────────────────

  describe('marking yourself unavailable', () => {
    it('records not_available for somebody with no spot', async () => {
      const outcome = await asUserCommitting(db, SEED_USERS.multiLeaguePlayer, async (client) => {
        const result = await client.query<{ status: string }>(
          'select * from public.mark_unavailable($1)',
          [SEED_MATCHES.fivesOpen],
        );
        return result.rows[0];
      });
      expect(outcome).toEqual({ status: 'not_available', waitlist_position: null });
    });

    it('releases a waitlist place and closes the gap behind it', async () => {
      await setCapacity(SEED_MATCHES.fivesOpen, 2);
      const members = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 5);
      for (const member of members) {
        await join(member.user, SEED_MATCHES.fivesOpen);
      }

      // members[0] and [1] are confirmed; [2] holds position 1, [3] position 2,
      // [4] position 3.
      await asUserCommitting(db, members[2]!.user, (client) =>
        client.query('select * from public.mark_unavailable($1)', [SEED_MATCHES.fivesOpen]),
      );

      expect(await waitlistOrder(SEED_MATCHES.fivesOpen)).toEqual([
        members[3]!.membershipId,
        members[4]!.membershipId,
      ]);
      const { rows } = await db.pool.query<{ positions: string }>(
        `select array_agg(waitlist_position order by waitlist_position)::text as positions
           from public.match_signups where match_id = $1 and status = 'waitlisted'`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows[0]?.positions).toBe('{1,2}');
    });

    it('refuses a confirmed player, because that is cancellation', async () => {
      await join(SEED_USERS.multiLeaguePlayer, SEED_MATCHES.fivesOpen);

      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.multiLeaguePlayer, (client) =>
          client.query('select * from public.mark_unavailable($1)', [SEED_MATCHES.fivesOpen]),
        ),
      );

      // Doing the visible half — freeing the slot — without the cutoff
      // classification, the administrator alert and the replacement would leave
      // a player believing they were released when nobody had been told.
      expect(error.message).toContain('SIGNUP_CANCELLATION_UNAVAILABLE');
      expect(
        (await statusOf(SEED_MATCHES.fivesOpen, SEED_MEMBERSHIPS.fivesMultiLeaguePlayer))?.status,
      ).toBe('confirmed');
    });

    it('creates no notification', async () => {
      await asUserCommitting(db, SEED_USERS.multiLeaguePlayer, (client) =>
        client.query('select * from public.mark_unavailable($1)', [SEED_MATCHES.fivesOpen]),
      );
      const { rows } = await db.pool.query<{ count: string }>(
        'select count(*)::text as count from public.notifications where match_id = $1',
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows[0]?.count).toBe('0');
    });
  });

  // ── Administrator-approved requests ──────────────────────────────────────

  describe('requesting a spot', () => {
    it('records interest without consuming capacity', async () => {
      const outcome = await asUserCommitting(db, SEED_USERS.multiLeaguePlayer, async (client) => {
        const result = await client.query<{ status: string }>(
          'select * from public.request_spot($1)',
          [SEED_MATCHES.rmvfcOpen],
        );
        return result.rows[0];
      });

      expect(outcome).toEqual({ status: 'interested', waitlist_position: null });

      const { rows } = await db.pool.query<{ confirmed: number }>(
        'select public.match_confirmed_count($1) as confirmed',
        [SEED_MATCHES.rmvfcOpen],
      );
      expect(rows[0]?.confirmed).toBe(0);
    });

    it('is idempotent and never resets a decision already made', async () => {
      await asUserCommitting(db, SEED_USERS.multiLeaguePlayer, (client) =>
        client.query('select * from public.request_spot($1)', [SEED_MATCHES.rmvfcOpen]),
      );
      await asUserCommitting(db, SEED_USERS.rmvfcAdmin, (client) =>
        client.query('select * from public.set_signup_decision($1, $2, $3)', [
          SEED_MATCHES.rmvfcOpen,
          SEED_MEMBERSHIPS.rmvfcMultiLeaguePlayer,
          'confirmed',
        ]),
      );

      const after = await asUserCommitting(db, SEED_USERS.multiLeaguePlayer, async (client) => {
        const result = await client.query<{ status: string }>(
          'select * from public.request_spot($1)',
          [SEED_MATCHES.rmvfcOpen],
        );
        return result.rows[0];
      });

      // Tapping the button again must not demote a confirmed player.
      expect(after?.status).toBe('confirmed');
    });

    it('creates exactly one signup_pending notification', async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await asUserCommitting(db, SEED_USERS.multiLeaguePlayer, (client) =>
          client.query('select * from public.request_spot($1)', [SEED_MATCHES.rmvfcOpen]),
        );
      }
      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications
          where match_id = $1 and type = 'signup_pending'`,
        [SEED_MATCHES.rmvfcOpen],
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('refuses on a first-come match', async () => {
      const error = await expectDatabaseError(() =>
        asUser(db, SEED_USERS.multiLeaguePlayer, (client) =>
          client.query('select * from public.request_spot($1)', [SEED_MATCHES.fivesOpen]),
        ),
      );
      expect(error.message).toContain('SIGNUP_MODE_MISMATCH');
    });
  });

  // ── Administrator decisions ──────────────────────────────────────────────

  describe('administrator decisions', () => {
    let members: ExtraMember[];

    beforeEach(async () => {
      members = await createExtraMembers(db, SEED_LEAGUES.rmvfc, 5);
      // Everybody registers interest in the admin_approval match.
      for (const member of members) {
        await asUserCommitting(db, member.user, (client) =>
          client.query('select * from public.request_spot($1)', [SEED_MATCHES.rmvfcOpen]),
        );
      }
    });

    async function decide(
      user: { id: string; email: string },
      membershipId: string,
      status: string,
      reason: string | null = null,
    ) {
      return asUserCommitting(db, user, async (client) => {
        const result = await client.query<{ status: string; waitlist_position: number | null }>(
          'select * from public.set_signup_decision($1, $2, $3, $4)',
          [SEED_MATCHES.rmvfcOpen, membershipId, status, reason],
        );
        return result.rows[0];
      });
    }

    it('confirms a player and records who decided', async () => {
      const outcome = await decide(
        SEED_USERS.rmvfcAdmin,
        members[0]!.membershipId,
        'confirmed',
      );
      expect(outcome).toEqual({ status: 'confirmed', waitlist_position: null });

      const { rows } = await db.pool.query<{ selected_by: string; selected_at: string }>(
        'select selected_by, selected_at from public.match_signups where membership_id = $1',
        [members[0]!.membershipId],
      );
      expect(rows[0]?.selected_by).toBe(SEED_USERS.rmvfcAdmin.id);
      expect(rows[0]?.selected_at).not.toBeNull();
    });

    it('waitlists players in sequence', async () => {
      await decide(SEED_USERS.rmvfcAdmin, members[0]!.membershipId, 'waitlisted');
      await decide(SEED_USERS.rmvfcAdmin, members[1]!.membershipId, 'waitlisted');

      expect(await waitlistOrder(SEED_MATCHES.rmvfcOpen)).toEqual([
        members[0]!.membershipId,
        members[1]!.membershipId,
      ]);
    });

    it('drops the waitlist position when a waitlisted player is confirmed', async () => {
      await decide(SEED_USERS.rmvfcAdmin, members[0]!.membershipId, 'waitlisted');
      await decide(SEED_USERS.rmvfcAdmin, members[1]!.membershipId, 'waitlisted');
      await decide(SEED_USERS.rmvfcAdmin, members[0]!.membershipId, 'confirmed');

      const promoted = await statusOf(SEED_MATCHES.rmvfcOpen, members[0]!.membershipId);
      expect(promoted).toEqual({ status: 'confirmed', waitlist_position: null });

      // The person behind them moves up rather than staying at two.
      expect(
        (await statusOf(SEED_MATCHES.rmvfcOpen, members[1]!.membershipId))?.waitlist_position,
      ).toBe(1);
    });

    it('removes the waitlist position when a player is passed over', async () => {
      await decide(SEED_USERS.rmvfcAdmin, members[0]!.membershipId, 'waitlisted');
      await decide(SEED_USERS.rmvfcAdmin, members[1]!.membershipId, 'waitlisted');
      await decide(SEED_USERS.rmvfcAdmin, members[0]!.membershipId, 'not_selected');

      expect(
        await statusOf(SEED_MATCHES.rmvfcOpen, members[0]!.membershipId),
      ).toEqual({ status: 'not_selected', waitlist_position: null });
      expect(await waitlistOrder(SEED_MATCHES.rmvfcOpen)).toEqual([members[1]!.membershipId]);
    });

    it('is idempotent', async () => {
      const first = await decide(SEED_USERS.rmvfcAdmin, members[0]!.membershipId, 'waitlisted');
      const again = await decide(SEED_USERS.rmvfcAdmin, members[0]!.membershipId, 'waitlisted');
      expect(again).toEqual(first);
      expect(await waitlistOrder(SEED_MATCHES.rmvfcOpen)).toEqual([members[0]!.membershipId]);
    });

    it('refuses to exceed capacity', async () => {
      await setCapacity(SEED_MATCHES.rmvfcOpen, 2);
      await decide(SEED_USERS.rmvfcAdmin, members[0]!.membershipId, 'confirmed');
      await decide(SEED_USERS.rmvfcAdmin, members[1]!.membershipId, 'confirmed');

      const error = await expectDatabaseError(() =>
        decide(SEED_USERS.rmvfcAdmin, members[2]!.membershipId, 'confirmed'),
      );
      expect(error.message).toContain('CAPACITY_EXCEEDED');
    });

    it('refuses a player, and a cross-league administrator, identically', async () => {
      for (const user of [SEED_USERS.rmvfcPlayer, SEED_USERS.fivesAdmin]) {
        const error = await expectDatabaseError(() =>
          decide(user, members[0]!.membershipId, 'confirmed'),
        );
        expect(error.message).toContain('NOT_LEAGUE_ADMIN');
      }
    });

    it('refuses a membership from another league as if it did not exist', async () => {
      const error = await expectDatabaseError(() =>
        decide(SEED_USERS.rmvfcAdmin, SEED_MEMBERSHIPS.fivesMultiLeaguePlayer, 'confirmed'),
      );
      expect(error.message).toContain('MEMBERSHIP_REQUIRED');
    });

    it('refuses to place a suspended member on the roster', async () => {
      const error = await expectDatabaseError(() =>
        decide(SEED_USERS.rmvfcAdmin, SEED_MEMBERSHIPS.rmvfcSuspended, 'confirmed'),
      );
      expect(error.message).toContain('MEMBERSHIP_INACTIVE');
    });

    it('writes an audit event carrying no personal detail', async () => {
      await decide(
        SEED_USERS.rmvfcAdmin,
        members[0]!.membershipId,
        'confirmed',
        'Regular keeper',
      );

      const { rows } = await db.pool.query<{
        action: string;
        actor_user_id: string;
        after_data: Record<string, unknown>;
        reason: string;
      }>(
        `select action, actor_user_id, after_data, reason from public.audit_events
          where entity_id = $1 and action = 'roster.decision'`,
        [SEED_MATCHES.rmvfcOpen],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_user_id).toBe(SEED_USERS.rmvfcAdmin.id);
      expect(rows[0]?.after_data).toMatchObject({ status: 'confirmed' });
      expect(rows[0]?.reason).toBe('Regular keeper');
      // Membership id only — an audit row is readable by every future
      // administrator of the league.
      expect(JSON.stringify(rows[0])).not.toContain('Player1');
      expect(JSON.stringify(rows[0])).not.toContain('@matchday.test');
    });

    it('notifies nobody before the roster is published', async () => {
      await decide(SEED_USERS.rmvfcAdmin, members[0]!.membershipId, 'confirmed');
      await decide(SEED_USERS.rmvfcAdmin, members[1]!.membershipId, 'not_selected');

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.notifications
          where match_id = $1 and type in ('signup_confirmed', 'not_selected', 'waitlisted')`,
        [SEED_MATCHES.rmvfcOpen],
      );
      // Announcing each click would tell somebody they were cut while the
      // administrator was still moving names around.
      expect(rows[0]?.count).toBe('0');
    });
  });

  // ── Waitlist reordering ──────────────────────────────────────────────────

  describe('reordering the waitlist', () => {
    let members: ExtraMember[];

    beforeEach(async () => {
      await setCapacity(SEED_MATCHES.fivesOpen, 2);
      members = await createExtraMembers(db, SEED_LEAGUES.weeknightFives, 6);
      for (const member of members) {
        await join(member.user, SEED_MATCHES.fivesOpen);
      }
    });

    async function reorder(order: string[], user: SeedUser = SEED_USERS.fivesAdmin) {
      return asUserCommitting(db, user, async (client) => {
        const result = await client.query<{ reorder_waitlist: number }>(
          'select public.reorder_waitlist($1, $2)',
          [SEED_MATCHES.fivesOpen, order],
        );
        return result.rows[0]?.reorder_waitlist;
      });
    }

    it('applies a full reversal without tripping the unique constraint', async () => {
      const current = await waitlistOrder(SEED_MATCHES.fivesOpen);
      const reversed = [...current].reverse();

      // The permutation most likely to collide part-way through a statement.
      expect(await reorder(reversed)).toBe(reversed.length);
      expect(await waitlistOrder(SEED_MATCHES.fivesOpen)).toEqual(reversed);
    });

    it('leaves positions 1..N with no gaps or duplicates', async () => {
      const current = await waitlistOrder(SEED_MATCHES.fivesOpen);
      await reorder([...current].reverse());

      const { rows } = await db.pool.query<{ positions: string }>(
        `select array_agg(waitlist_position order by waitlist_position)::text as positions
           from public.match_signups where match_id = $1 and status = 'waitlisted'`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows[0]?.positions).toBe('{1,2,3,4}');  // four waitlisted behind two confirmed
    });

    it('refuses an ordering that omits somebody', async () => {
      const current = await waitlistOrder(SEED_MATCHES.fivesOpen);
      const error = await expectDatabaseError(() => reorder(current.slice(1)));
      expect(error.message).toContain('WAITLIST_CONFLICT');
    });

    it('refuses an ordering that repeats a player', async () => {
      const current = await waitlistOrder(SEED_MATCHES.fivesOpen);
      const error = await expectDatabaseError(() =>
        reorder([current[0]!, current[0]!, current[1]!, current[2]!]),
      );
      expect(error.message).toContain('WAITLIST_CONFLICT');
    });

    it('refuses an ordering naming somebody who is not waitlisted', async () => {
      const current = await waitlistOrder(SEED_MATCHES.fivesOpen);
      const error = await expectDatabaseError(() =>
        reorder([...current.slice(1), members[0]!.membershipId]),
      );
      expect(error.message).toContain('WAITLIST_CONFLICT');
    });

    it('refuses a membership from another league', async () => {
      const current = await waitlistOrder(SEED_MATCHES.fivesOpen);
      const error = await expectDatabaseError(() =>
        reorder([...current.slice(1), SEED_MEMBERSHIPS.rmvfcPlayer]),
      );
      expect(error.message).toContain('WAITLIST_CONFLICT');
    });

    it('refuses a player and a cross-league administrator', async () => {
      const current = await waitlistOrder(SEED_MATCHES.fivesOpen);
      for (const user of [SEED_USERS.multiLeaguePlayer, SEED_USERS.rmvfcAdmin]) {
        const error = await expectDatabaseError(() => reorder(current, user));
        expect(error.message).toContain('NOT_LEAGUE_ADMIN');
      }
    });

    it('audits the order without recording who the people are', async () => {
      const current = await waitlistOrder(SEED_MATCHES.fivesOpen);
      await reorder([...current].reverse());

      const { rows } = await db.pool.query<{ before_data: unknown; after_data: unknown }>(
        `select before_data, after_data from public.audit_events
          where entity_id = $1 and action = 'roster.waitlist_reordered'`,
        [SEED_MATCHES.fivesOpen],
      );
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).not.toContain('@matchday.test');
      expect(JSON.stringify(rows[0])).not.toContain('Player1');
    });
  });

  // ── Manual addition ──────────────────────────────────────────────────────

  describe('manual addition', () => {
    async function add(
      membershipId: string,
      status: string,
      reason: string | null = null,
      user: SeedUser = SEED_USERS.rmvfcAdmin,
      matchId: string = SEED_MATCHES.rmvfcOpen,
    ) {
      return asUserCommitting(db, user, async (client) => {
        const result = await client.query<{ status: string; waitlist_position: number | null }>(
          'select * from public.add_member_to_match($1, $2, $3, $4)',
          [matchId, membershipId, status, reason],
        );
        return result.rows[0];
      });
    }

    it('adds an active member to the confirmed roster', async () => {
      expect(await add(SEED_MEMBERSHIPS.rmvfcMultiLeaguePlayer, 'confirmed')).toEqual({
        status: 'confirmed',
        waitlist_position: null,
      });
    });

    it('adds an active member to the waitlist with a sequential position', async () => {
      const members = await createExtraMembers(db, SEED_LEAGUES.rmvfc, 2);
      expect(await add(members[0]!.membershipId, 'waitlisted')).toEqual({
        status: 'waitlisted',
        waitlist_position: 1,
      });
      expect(await add(members[1]!.membershipId, 'waitlisted')).toEqual({
        status: 'waitlisted',
        waitlist_position: 2,
      });
    });

    it('updates an existing signup rather than duplicating it', async () => {
      await asUserCommitting(db, SEED_USERS.multiLeaguePlayer, (client) =>
        client.query('select * from public.request_spot($1)', [SEED_MATCHES.rmvfcOpen]),
      );
      await add(SEED_MEMBERSHIPS.rmvfcMultiLeaguePlayer, 'confirmed');

      const { rows } = await db.pool.query<{ count: string }>(
        `select count(*)::text as count from public.match_signups
          where match_id = $1 and membership_id = $2`,
        [SEED_MATCHES.rmvfcOpen, SEED_MEMBERSHIPS.rmvfcMultiLeaguePlayer],
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('is idempotent', async () => {
      const first = await add(SEED_MEMBERSHIPS.rmvfcMultiLeaguePlayer, 'confirmed');
      expect(await add(SEED_MEMBERSHIPS.rmvfcMultiLeaguePlayer, 'confirmed')).toEqual(first);
    });

    it('refuses a suspended or removed member', async () => {
      for (const membershipId of [SEED_MEMBERSHIPS.rmvfcSuspended, SEED_MEMBERSHIPS.rmvfcRemoved]) {
        const error = await expectDatabaseError(() => add(membershipId, 'confirmed'));
        expect(error.message).toContain('MEMBERSHIP_INACTIVE');
      }
    });

    it('refuses a member of another league as if they did not exist', async () => {
      const error = await expectDatabaseError(() =>
        add(SEED_MEMBERSHIPS.fivesMultiLeaguePlayer, 'confirmed'),
      );
      expect(error.message).toContain('MEMBERSHIP_REQUIRED');
    });

    it('refuses a member who has not accepted the required guidelines', async () => {
      // Not overrideable: no document grants an administrator permission to put
      // somebody on a roster who has not agreed to the league's rules.
      const error = await expectDatabaseError(() =>
        add(SEED_MEMBERSHIPS.rmvfcPlayer, 'confirmed', 'They said yes verbally'),
      );
      expect(error.message).toContain('GUIDELINES_NOT_ACCEPTED');
    });

    it('refuses to exceed capacity', async () => {
      await setCapacity(SEED_MATCHES.rmvfcOpen, 2);
      const members = await createExtraMembers(db, SEED_LEAGUES.rmvfc, 3);
      await add(members[0]!.membershipId, 'confirmed');
      await add(members[1]!.membershipId, 'confirmed');

      const error = await expectDatabaseError(() => add(members[2]!.membershipId, 'confirmed'));
      expect(error.message).toContain('CAPACITY_EXCEEDED');
    });

    it('requires a reason once the deadline has passed, and records the override', async () => {
      await db.pool.query(
        `update public.matches
            set signup_closes_at = now() - interval '1 hour',
                priority_window_ends_at = null
          where id = $1`,
        [SEED_MATCHES.rmvfcOpen],
      );

      const refused = await expectDatabaseError(() =>
        add(SEED_MEMBERSHIPS.rmvfcMultiLeaguePlayer, 'confirmed'),
      );
      expect(refused.message).toContain('SIGNUP_CLOSED');

      await add(SEED_MEMBERSHIPS.rmvfcMultiLeaguePlayer, 'confirmed', 'Replacement keeper');

      const { rows } = await db.pool.query<{
        override_reason: string;
        after_data: Record<string, unknown>;
      }>(
        `select s.override_reason, a.after_data
           from public.match_signups s
           join public.audit_events a on a.entity_id = s.match_id
          where s.membership_id = $1 and a.action = 'roster.manual_add'`,
        [SEED_MEMBERSHIPS.rmvfcMultiLeaguePlayer],
      );
      expect(rows[0]?.override_reason).toBe('Replacement keeper');
      expect(rows[0]?.after_data['deadline_overridden']).toBe(true);
    });

    it('refuses a player and a cross-league administrator', async () => {
      for (const user of [SEED_USERS.rmvfcPlayer, SEED_USERS.fivesAdmin]) {
        const error = await expectDatabaseError(() =>
          add(SEED_MEMBERSHIPS.rmvfcMultiLeaguePlayer, 'confirmed', null, user),
        );
        expect(error.message).toContain('NOT_LEAGUE_ADMIN');
      }
    });
  });
});

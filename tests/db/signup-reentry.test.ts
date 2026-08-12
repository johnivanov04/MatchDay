import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asUserCommitting,
  createExtraMembers,
  createTestDatabase,
  expectDatabaseError,
  SEED_LEAGUES,
  SEED_MATCHES,
  SEED_USERS,
  type ExtraMember,
  type SeedUser,
  type TestDatabase,
} from './helpers/harness';

/**
 * Re-entering the SAME match after cancelling.
 *
 * Phase 7 made this possible — see `20260817080500_signup_rejoin_fix.sql`.
 * Before it, `cancel_spot()` wrote `canceled_at` and nothing ever cleared it,
 * so every route back into a match failed
 * `match_signups_cancellation_fields_reserved` and a cancellation was
 * permanent.
 *
 * No approved document decides what re-entry should mean, so ADR 0002 records
 * the decision and this file is its executable half. The two properties that
 * carry the most weight, because they are the ones a careless change would
 * quietly break:
 *
 *   * **one row, ever** — re-entry reuses the existing `match_signups` row, so
 *     capacity accounting cannot double-count anybody;
 *   * **history is never erased** — the live row describes only the *current*
 *     state, and every cancellation that ever happened stays in `audit_events`
 *     and in the notifications the player was sent.
 */
describe('re-entering the same match after cancelling', () => {
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

  // ── Helpers ──────────────────────────────────────────────────────────────

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

  const join = (member: ExtraMember) =>
    callAs(member.user, 'select public.join_match($1)', [match]);

  const cancel = (member: ExtraMember, reason: string | null = null) =>
    callAs(member.user, 'select public.cancel_spot($1, $2)', [match, reason]);

  /** Puts the cutoff in the past, so the next cancellation is classified late. */
  async function makeCancellationLate() {
    await db.pool.query(
      `update public.matches set cancellation_cutoff_at = now() - interval '1 hour'
        where id = $1`,
      [match],
    );
  }

  /** Restores an on-time window. */
  async function makeCancellationOnTime() {
    await db.pool.query(
      `update public.matches set cancellation_cutoff_at = kickoff_at - interval '1 day'
        where id = $1`,
      [match],
    );
  }

  async function signupRow(member: ExtraMember) {
    const { rows } = await db.pool.query<{
      status: string;
      canceled_at: string | null;
      cancellation_reason: string | null;
      confirmed_at: string | null;
      waitlist_position: number | null;
    }>(
      `select status, canceled_at::text, cancellation_reason, confirmed_at::text,
              waitlist_position
         from public.match_signups where match_id = $1 and membership_id = $2`,
      [match, member.membershipId],
    );
    return rows[0] ?? null;
  }

  async function signupRowCount(member: ExtraMember) {
    const { rows } = await db.pool.query<{ n: string }>(
      'select count(*)::text as n from public.match_signups where match_id = $1 and membership_id = $2',
      [match, member.membershipId],
    );
    return Number(rows[0]!.n);
  }

  /** Every cancellation this member has ever had recorded, oldest first. */
  async function cancellationHistory(member: ExtraMember) {
    const { rows } = await db.pool.query<{ status: string; late: boolean }>(
      `select after_data ->> 'status' as status, (after_data ->> 'late')::boolean as late
         from public.audit_events
        where action = 'signup.canceled'
          and after_data ->> 'membership_id' = $1
        order by created_at, id`,
      [member.membershipId],
    );
    return rows;
  }

  async function receiptCount(member: ExtraMember) {
    const { rows } = await db.pool.query<{ n: string }>(
      `select count(*)::text as n from public.notifications
        where match_id = $1 and recipient_user_id = $2 and type = 'cancellation_receipt'`,
      [match, member.user.id],
    );
    return Number(rows[0]!.n);
  }

  async function confirmedCount() {
    const { rows } = await db.pool.query<{ count: number }>(
      'select public.match_confirmed_count($1) as count',
      [match],
    );
    return rows[0]!.count;
  }

  // ══ A. Which states may re-enter ═════════════════════════════════════════

  describe('which states may re-enter', () => {
    it('lets an on-time canceller back in', async () => {
      await join(members[0]!);
      await cancel(members[0]!, 'Work ran over');

      await join(members[0]!);

      expect((await signupRow(members[0]!))!.status).toBe('confirmed');
    });

    it('lets a late withdrawer back in', async () => {
      await join(members[0]!);
      await makeCancellationLate();
      await cancel(members[0]!, 'Car broke down');
      expect((await signupRow(members[0]!))!.status).toBe('withdrawn_late');

      await makeCancellationOnTime();
      await join(members[0]!);

      // A late withdrawal is a fact about a past decision, not a sanction. 04
      // §1 keeps discipline with the administrator, so the product does not
      // invent a lockout the club never asked for.
      expect((await signupRow(members[0]!))!.status).toBe('confirmed');
    });

    it('lets somebody who was only ever waitlisted and left rejoin', async () => {
      await db.pool.query('update public.matches set capacity = 2 where id = $1', [match]);
      await join(members[0]!);
      await join(members[1]!);
      await join(members[2]!); // waitlisted
      await cancel(members[2]!);

      await join(members[2]!);

      expect((await signupRow(members[2]!))!.status).toBe('waitlisted');
    });

    it('does not resurrect somebody an administrator did not select', async () => {
      // `not_selected` is an administrator decision, not a withdrawal. Asking
      // again is harmless and answers with the decision that stands — Phase 4's
      // rule that a re-tap "never overwrites a decision the administrator has
      // already made". Re-entry is not a route around it; the administrator
      // confirms them directly if they change their mind.
      await db.pool.query(
        `update public.matches set selection_mode = 'admin_approval' where id = $1`,
        [match],
      );
      await callAs(members[0]!.user, 'select public.request_spot($1)', [match]);
      await callAs(admin, `select public.set_signup_decision($1, $2, 'not_selected')`, [
        match,
        members[0]!.membershipId,
      ]);

      await callAs(members[0]!.user, 'select public.request_spot($1)', [match]);

      expect((await signupRow(members[0]!))!.status).toBe('not_selected');
      expect(await signupRowCount(members[0]!)).toBe(1);
    });
  });

  // ══ B. Re-entry obeys every ordinary rule ════════════════════════════════

  describe('player-driven re-entry obeys the ordinary signup rules', () => {
    it('is refused once the membership is no longer active', async () => {
      await join(members[0]!);
      await cancel(members[0]!);
      await callAs(admin, `select public.set_membership_status($1, 'suspended', 'Under review')`, [
        members[0]!.membershipId,
      ]);

      const error = await expectDatabaseError(() => join(members[0]!));
      expect(error.message).toContain('MEMBERSHIP_REQUIRED');
    });

    it('is refused while the current guidelines are unaccepted', async () => {
      await join(members[0]!);
      await cancel(members[0]!);

      // The seeded 5v5 league requires no guidelines, so the gate has to be
      // built before it can be tested — publishing a version that requires
      // acceptance is exactly what makes it apply.
      const { rows } = await db.pool.query<{ id: string }>(
        `insert into public.guideline_versions
           (league_id, version_label, title, body, requires_acceptance, effective_at)
         values ($1, 'reentry-test', 'House rules', 'Be on time.', true, now())
         returning id`,
        [SEED_LEAGUES.weeknightFives],
      );
      await callAs(admin, 'select public.publish_guideline_version($1)', [rows[0]!.id]);

      const error = await expectDatabaseError(() => join(members[0]!));
      expect(error.message).toContain('GUIDELINES_NOT_ACCEPTED');

      // And accepting it lets them straight back in.
      await callAs(members[0]!.user, 'select public.accept_guideline_version($1)', [rows[0]!.id]);
      await join(members[0]!);
      expect((await signupRow(members[0]!))!.status).toBe('confirmed');
    });

    it('is refused once signup has closed', async () => {
      await join(members[0]!);
      await cancel(members[0]!);
      await db.pool.query(
        `update public.matches set signup_closes_at = now() - interval '1 hour' where id = $1`,
        [match],
      );

      const error = await expectDatabaseError(() => join(members[0]!));
      expect(error.message).toContain('SIGNUP_CLOSED');
    });

    it('is refused once the match is no longer open', async () => {
      await join(members[0]!);
      await cancel(members[0]!);
      await db.pool.query(
        `update public.matches
            set status = 'canceled', canceled_at = now(), cancellation_reason = 'Waterlogged'
          where id = $1`,
        [match],
      );

      const error = await expectDatabaseError(() => join(members[0]!));
      expect(error.message).toContain('MATCH_NOT_OPEN');
    });

    it('goes onto the waitlist when the match refilled behind them', async () => {
      await db.pool.query('update public.matches set capacity = 2 where id = $1', [match]);
      await join(members[0]!);
      await join(members[1]!);
      await cancel(members[0]!);
      await join(members[2]!); // takes the freed spot

      await join(members[0]!);

      // No privileged re-admission. They queue like anybody arriving now.
      expect((await signupRow(members[0]!))!.status).toBe('waitlisted');
      expect(await confirmedCount()).toBe(2);
    });
  });

  // ══ C. Administrator re-entry ════════════════════════════════════════════

  describe('administrator re-entry obeys the administrator rules', () => {
    it('re-adds a canceller directly', async () => {
      await join(members[0]!);
      await cancel(members[0]!, 'Injured');

      await callAs(admin, `select public.add_member_to_match($1, $2, 'confirmed')`, [
        match,
        members[0]!.membershipId,
      ]);

      expect((await signupRow(members[0]!))!.status).toBe('confirmed');
    });

    it('still refuses to exceed capacity', async () => {
      await db.pool.query('update public.matches set capacity = 2 where id = $1', [match]);
      await join(members[0]!);
      await join(members[1]!);
      await cancel(members[0]!);
      await join(members[2]!);

      const error = await expectDatabaseError(() =>
        callAs(admin, `select public.add_member_to_match($1, $2, 'confirmed')`, [
          match,
          members[0]!.membershipId,
        ]),
      );
      expect(error.message).toContain('CAPACITY_EXCEEDED');
    });

    it('still requires an override reason after the deadline', async () => {
      await join(members[0]!);
      await cancel(members[0]!);
      await db.pool.query(
        `update public.matches set signup_closes_at = now() - interval '1 hour' where id = $1`,
        [match],
      );

      const error = await expectDatabaseError(() =>
        callAs(admin, `select public.add_member_to_match($1, $2, 'confirmed')`, [
          match,
          members[0]!.membershipId,
        ]),
      );
      expect(error.message).toContain('SIGNUP_CLOSED');

      await callAs(
        admin,
        `select public.add_member_to_match($1, $2, 'confirmed', 'Replacement found on the day')`,
        [match, members[0]!.membershipId],
      );
      expect((await signupRow(members[0]!))!.status).toBe('confirmed');
    });

    it('refuses to re-add a member who is no longer active', async () => {
      await join(members[0]!);
      await cancel(members[0]!);
      await callAs(admin, `select public.set_membership_status($1, 'removed', 'Left the club')`, [
        members[0]!.membershipId,
      ]);

      const error = await expectDatabaseError(() =>
        callAs(admin, `select public.add_member_to_match($1, $2, 'confirmed')`, [
          match,
          members[0]!.membershipId,
        ]),
      );
      expect(error.message).toContain('MEMBERSHIP_INACTIVE');
    });
  });

  // ══ D + E + F. One row, a durable marker, and history that survives ══════

  describe('the row, the marker and the history', () => {
    it('reuses the one signup row rather than adding a second', async () => {
      await join(members[0]!);
      await cancel(members[0]!);
      await join(members[0]!);
      await cancel(members[0]!);
      await join(members[0]!);

      expect(await signupRowCount(members[0]!)).toBe(1);
    });

    it('clears the live cancellation fields when they come back', async () => {
      await join(members[0]!);
      await cancel(members[0]!, 'Work ran over');
      await join(members[0]!);

      const row = (await signupRow(members[0]!))!;
      // These two describe the row's *current* state, and the check constraint
      // says a non-cancelled row carries neither.
      expect(row.canceled_at).toBeNull();
      expect(row.cancellation_reason).toBeNull();
    });

    it('never clears confirmed_at', async () => {
      await join(members[0]!);
      const first = (await signupRow(members[0]!))!.confirmed_at;
      expect(first).not.toBeNull();

      await cancel(members[0]!);
      expect((await signupRow(members[0]!))!.confirmed_at).toBe(first);

      await join(members[0]!);
      // First-wins, so the instant they were first counted on survives every
      // round trip. This is what makes the attendance register answerable.
      expect((await signupRow(members[0]!))!.confirmed_at).toBe(first);
    });
  });

  // ══ The five named scenarios ═════════════════════════════════════════════

  describe('scenario 1 — confirmed, late cancellation, rejoin', () => {
    it('leaves a valid current signup and an intact late-cancellation history', async () => {
      await join(members[0]!);
      await makeCancellationLate();
      await cancel(members[0]!, 'Car broke down');
      await makeCancellationOnTime();
      await join(members[0]!);

      const row = (await signupRow(members[0]!))!;
      expect(row.status).toBe('confirmed');
      expect(row.canceled_at).toBeNull();
      expect(row.confirmed_at).not.toBeNull();

      // The late withdrawal is still on the record, still labelled late.
      const history = await cancellationHistory(members[0]!);
      expect(history).toHaveLength(1);
      expect(history[0]).toEqual({ status: 'withdrawn_late', late: true });

      // And what the player was told about it was not deleted.
      expect(await receiptCount(members[0]!)).toBe(1);
    });

    it('leaves the administrator’s late-withdrawal alert in place', async () => {
      await join(members[0]!);
      await makeCancellationLate();
      await cancel(members[0]!, 'Car broke down');
      await makeCancellationOnTime();
      await join(members[0]!);

      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.notifications
          where match_id = $1 and type = 'late_cancellation'`,
        [match],
      );
      expect(Number(rows[0]!.n)).toBe(1);
    });
  });

  describe('scenario 2 — confirmed, on-time cancellation, rejoin, attended', () => {
    it('records attendance as attended, because they ultimately played', async () => {
      await join(members[0]!);
      await cancel(members[0]!, 'Thought I had a clash');
      await join(members[0]!);

      // The match finishes. Ten days, not three: the seeded match sits a few
      // days ahead, and a shift smaller than that leaves it in the future.
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

      await callAs(admin, `select public.record_attendance($1, $2, 'attended')`, [
        match,
        members[0]!.membershipId,
      ]);

      const { rows } = await db.pool.query<{ outcome: string }>(
        'select outcome::text from public.attendance_records where match_id = $1 and membership_id = $2',
        [match, members[0]!.membershipId],
      );
      // `attended` is available precisely because the *current* signup state is
      // confirmed. Had the earlier cancellation still governed the row, the
      // outcome validation would have refused it — and it would have been
      // wrong to, because the player turned up and played.
      expect(rows[0]!.outcome).toBe('attended');

      // The earlier withdrawal is still auditable.
      expect(await cancellationHistory(members[0]!)).toHaveLength(1);
    });
  });

  describe('scenario 3 — confirmed, late cancellation, rejoin, cancel again', () => {
    it('keeps both cancellations auditable and reflects only the latest state', async () => {
      await join(members[0]!);

      await makeCancellationLate();
      await cancel(members[0]!, 'First withdrawal');

      await makeCancellationOnTime();
      await join(members[0]!);
      await cancel(members[0]!, 'Second withdrawal');

      const history = await cancellationHistory(members[0]!);
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({ status: 'withdrawn_late', late: true });
      expect(history[1]).toEqual({ status: 'canceled', late: false });

      const row = (await signupRow(members[0]!))!;
      // The live row is the latest state and nothing else.
      expect(row.status).toBe('canceled');
      expect(row.cancellation_reason).toBe('Second withdrawal');
      expect(row.confirmed_at).not.toBeNull();
      expect(await signupRowCount(members[0]!)).toBe(1);

      // Two distinct receipts: the classification is in the idempotency key, so
      // the second cancellation told them again rather than being swallowed.
      expect(await receiptCount(members[0]!)).toBe(2);
    });

    it('still lists them in the attendance register, once', async () => {
      await join(members[0]!);
      await makeCancellationLate();
      await cancel(members[0]!, 'First withdrawal');
      await makeCancellationOnTime();
      await join(members[0]!);
      await cancel(members[0]!, 'Second withdrawal');

      const { rows } = await db.pool.query<{ id: string }>(
        'select id from public.match_attendance_population($1) id',
        [match],
      );
      expect(rows.map((r) => r.id)).toEqual([members[0]!.membershipId]);
    });
  });

  describe('scenario 4 — a waitlist-only member who never got in', () => {
    it('gains no confirmed_at from joining, cancelling and rejoining the queue', async () => {
      await db.pool.query('update public.matches set capacity = 2 where id = $1', [match]);
      await join(members[0]!);
      await join(members[1]!);

      await join(members[2]!); // waitlisted
      expect((await signupRow(members[2]!))!.confirmed_at).toBeNull();

      await cancel(members[2]!);
      expect((await signupRow(members[2]!))!.confirmed_at).toBeNull();

      await join(members[2]!); // waitlisted again
      const row = (await signupRow(members[2]!))!;
      expect(row.status).toBe('waitlisted');
      // The marker means "was ever confirmed", not "was ever in this match".
      expect(row.confirmed_at).toBeNull();

      // And so they are still absent from the attendance register.
      const { rows } = await db.pool.query<{ id: string }>(
        'select id from public.match_attendance_population($1) id',
        [match],
      );
      expect(rows.map((r) => r.id)).not.toContain(members[2]!.membershipId);
    });

    it('gains it the moment they are actually promoted', async () => {
      await db.pool.query(
        `update public.matches set capacity = 2, waitlist_mode = 'automatic' where id = $1`,
        [match],
      );
      await join(members[0]!);
      await join(members[1]!);
      await join(members[2]!);
      await cancel(members[2]!);
      await join(members[2]!); // back on the queue, still never confirmed

      await cancel(members[0]!); // frees a spot; members[2] is promoted

      const row = (await signupRow(members[2]!))!;
      expect(row.status).toBe('confirmed');
      expect(row.confirmed_at).not.toBeNull();
    });
  });

  describe('scenario 5 — duplicate re-entry requests', () => {
    it('leaves one row and correct capacity however many times they press it', async () => {
      await join(members[0]!);
      await join(members[1]!);
      await cancel(members[0]!);

      await join(members[0]!);
      await join(members[0]!);
      await join(members[0]!);

      expect(await signupRowCount(members[0]!)).toBe(1);
      expect((await signupRow(members[0]!))!.status).toBe('confirmed');
      expect(await confirmedCount()).toBe(2);
    });

    it('does not send a second confirmation notification for the same outcome', async () => {
      await join(members[0]!);
      await cancel(members[0]!);
      await join(members[0]!);
      await join(members[0]!);

      const { rows } = await db.pool.query<{ n: string }>(
        `select count(*)::text as n from public.notifications
          where match_id = $1 and recipient_user_id = $2 and type = 'signup_confirmed'`,
        [match, members[0]!.user.id],
      );
      // One per player per match: `join_match()` keys on the outcome, and the
      // second and third presses returned the spot they already held.
      expect(Number(rows[0]!.n)).toBe(1);
    });

    it('keeps capacity correct when the whole squad churns', async () => {
      await db.pool.query('update public.matches set capacity = 3 where id = $1', [match]);
      for (const member of members.slice(0, 3)) {
        await join(member);
      }
      for (const member of members.slice(0, 3)) {
        await cancel(member);
        await join(member);
      }

      expect(await confirmedCount()).toBe(3);
      for (const member of members.slice(0, 3)) {
        expect(await signupRowCount(member)).toBe(1);
      }
    });
  });
});

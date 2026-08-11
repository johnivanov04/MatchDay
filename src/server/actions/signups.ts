'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireLeagueAdmin } from '@/lib/auth/authorization';
import { actionFailure, actionSuccess, DomainError, type ActionResult } from '@/lib/errors';
import { domainErrorFromDatabase } from '@/lib/errors-from-database';
import { dispatchPushForKeyPrefix } from '@/lib/push/notify';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { SignupOutcome, SignupStatus } from '@/types/database';

/**
 * Phase 4 signup and roster actions.
 *
 * Each of these is a thin shell around a database function that owns the whole
 * transaction — the match row lock, the capacity decision, the waitlist
 * renumbering, the audit event and the canonical notification. That split is
 * deliberate: capacity cannot be enforced correctly from here, because two
 * concurrent requests run in two separate Node processes with no shared state,
 * and only the database can serialize them.
 *
 * So these functions validate shapes, call one RPC, and translate failures.
 * They never compute an outcome, and they never pass an actor, a league or a
 * role — the database derives all three from `auth.uid()`.
 */

const matchIdSchema = z.uuid();

/**
 * Pushes a fanout the database has already committed.
 *
 * Called after the transaction and outside every `try` that decides the
 * action's result, for the reason `pushCommittedFanout` in the match actions
 * gives: the signup is recorded and the canonical notification exists, so a
 * push that does not go out must never come back to the player as a failure.
 */
async function pushCommittedFanout(prefix: string): Promise<void> {
  try {
    await dispatchPushForKeyPrefix(prefix);
  } catch {
    /* deliberately silent — the notification is already safe in the inbox */
  }
}

/** Shared shape for the three player responses, which differ only in the RPC. */
async function playerSignupAction(
  rpc: 'join_match' | 'request_spot' | 'mark_unavailable',
  formData: FormData,
): Promise<ActionResult<SignupOutcome>> {
  let outcome: SignupOutcome;
  let pushPrefix: string | null = null;

  try {
    const matchId = matchIdSchema.parse(formData.get('match_id') ?? '');

    // No membership id, no league id, no eligibility flag. The only thing this
    // action knows is which match, and the database decides the rest.
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc(rpc, { p_match_id: matchId });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }
    if (data === null) {
      throw new DomainError('NOT_AUTHORIZED');
    }

    outcome = data;

    // Only the two outcomes that create a notification are worth pushing.
    if (rpc === 'join_match') {
      pushPrefix =
        outcome.status === 'confirmed'
          ? `signup_confirmed:${matchId}`
          : `waitlisted:${matchId}`;
    }
  } catch (error: unknown) {
    return actionFailure(error);
  }

  if (pushPrefix !== null) {
    await pushCommittedFanout(pushPrefix);
  }

  revalidatePath('/', 'layout');
  return actionSuccess(outcome);
}

/** First-come: claim a spot, or take the next waitlist position. */
export async function joinMatchAction(
  _previous: ActionResult<SignupOutcome> | null,
  formData: FormData,
): Promise<ActionResult<SignupOutcome>> {
  return playerSignupAction('join_match', formData);
}

/** Administrator-approved: register interest. Confirms nothing. */
export async function requestSpotAction(
  _previous: ActionResult<SignupOutcome> | null,
  formData: FormData,
): Promise<ActionResult<SignupOutcome>> {
  return playerSignupAction('request_spot', formData);
}

/**
 * "Can't play".
 *
 * Refused by the database for a player who holds a confirmed spot, because that
 * is cancellation and the rest of the cancellation workflow does not exist yet.
 * The refusal arrives here as `SIGNUP_CANCELLATION_UNAVAILABLE` and is shown as
 * such rather than being retried as something else.
 */
export async function markUnavailableAction(
  _previous: ActionResult<SignupOutcome> | null,
  formData: FormData,
): Promise<ActionResult<SignupOutcome>> {
  return playerSignupAction('mark_unavailable', formData);
}

// ── Administrator decisions ────────────────────────────────────────────────

const decisionStatusSchema = z.enum([
  'interested',
  'confirmed',
  'waitlisted',
  'not_selected',
]) satisfies z.ZodType<SignupStatus>;

const reasonSchema = z.string().max(500).optional();

/**
 * Confirm, waitlist, or pass over one player.
 *
 * `requireLeagueAdmin` runs first so an obvious refusal never reaches the
 * database, but it is not the security boundary — `set_signup_decision()`
 * re-checks administration from `auth.uid()` and Row Level Security refuses the
 * rows independently. A client that forged `league_id` here would still be
 * refused twice over.
 */
export async function setSignupDecisionAction(
  _previous: ActionResult<SignupOutcome> | null,
  formData: FormData,
): Promise<ActionResult<SignupOutcome>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    const matchId = matchIdSchema.parse(formData.get('match_id') ?? '');
    const membershipId = z.uuid().parse(formData.get('membership_id') ?? '');
    const status = decisionStatusSchema.parse(formData.get('status') ?? '');
    const reason = reasonSchema.parse(
      typeof formData.get('reason') === 'string' ? String(formData.get('reason')) : undefined,
    );

    await requireLeagueAdmin(leagueId);

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc('set_signup_decision', {
      p_match_id: matchId,
      p_membership_id: membershipId,
      p_status: status,
      p_reason: reason === undefined || reason === '' ? null : reason,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/', 'layout');
    return actionSuccess(data ?? { status, waitlist_position: null });
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/**
 * Reorder the whole waitlist.
 *
 * The form submits the membership ids in their new order. The database refuses
 * anything that is not exactly the current waitlist set, so a stale form — one
 * rendered before somebody left the waitlist — is rejected rather than applied
 * to a set it no longer describes.
 */
export async function reorderWaitlistAction(
  _previous: ActionResult<number> | null,
  formData: FormData,
): Promise<ActionResult<number>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    const matchId = matchIdSchema.parse(formData.get('match_id') ?? '');
    const membershipIds = z
      .array(z.uuid())
      .min(1)
      .parse(formData.getAll('membership_ids').map(String));

    await requireLeagueAdmin(leagueId);

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc('reorder_waitlist', {
      p_match_id: matchId,
      p_membership_ids: membershipIds,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/', 'layout');
    return actionSuccess(data ?? 0);
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/**
 * Manually add an existing active member.
 *
 * There is no email or user-id parameter, so this cannot pull somebody into the
 * league; it operates on a membership that already exists. The override reason
 * is required only when the deadline has passed, which the database decides —
 * it is the one rule F-06 marks as overrideable.
 */
export async function addMemberToMatchAction(
  _previous: ActionResult<SignupOutcome> | null,
  formData: FormData,
): Promise<ActionResult<SignupOutcome>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    const matchId = matchIdSchema.parse(formData.get('match_id') ?? '');
    const membershipId = z.uuid().parse(formData.get('membership_id') ?? '');
    const status = z.enum(['confirmed', 'waitlisted']).parse(formData.get('status') ?? '');
    const overrideReason = reasonSchema.parse(
      typeof formData.get('override_reason') === 'string'
        ? String(formData.get('override_reason'))
        : undefined,
    );

    await requireLeagueAdmin(leagueId);

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc('add_member_to_match', {
      p_match_id: matchId,
      p_membership_id: membershipId,
      p_status: status,
      p_override_reason:
        overrideReason === undefined || overrideReason === '' ? null : overrideReason,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error, { SIGNUP_CLOSED: 'override_reason' });
    }

    revalidatePath('/', 'layout');
    return actionSuccess(data ?? { status, waitlist_position: null });
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/**
 * Publish the roster.
 *
 * Sends every affected player exactly one notification saying what happened to
 * them, keyed on the new roster revision — so a repeated press announces
 * nothing, and a genuine later change announces again.
 */
export async function finalizeRosterAction(
  _previous: ActionResult<number> | null,
  formData: FormData,
): Promise<ActionResult<number>> {
  let matchId: string;
  let revision: number;

  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    matchId = matchIdSchema.parse(formData.get('match_id') ?? '');

    await requireLeagueAdmin(leagueId);

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc('finalize_roster', { p_match_id: matchId });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revision = data ?? 0;
  } catch (error: unknown) {
    return actionFailure(error);
  }

  // The revision is part of the notification key, so pushing the right batch
  // means asking for the revision the database just produced.
  await pushCommittedFanout(`roster_outcome:${matchId}:${String(revision)}`);

  revalidatePath('/', 'layout');
  return actionSuccess(revision);
}

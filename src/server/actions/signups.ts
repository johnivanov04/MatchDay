'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireLeagueAdmin } from '@/lib/auth/authorization';
import { actionFailure, actionSuccess, DomainError, type ActionResult } from '@/lib/errors';
import { domainErrorFromDatabase } from '@/lib/errors-from-database';
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

/** Shared shape for the player responses, which differ only in the RPC. */
async function playerSignupAction(
  rpc: 'join_match' | 'request_spot' | 'mark_unavailable' | 'cancel_spot',
  formData: FormData,
  extra: Record<string, unknown> = {},
): Promise<ActionResult<SignupOutcome>> {
  let outcome: SignupOutcome;

  try {
    const matchId = matchIdSchema.parse(formData.get('match_id') ?? '');

    // No membership id, no league id, no eligibility flag. The only thing this
    // action knows is which match, and the database decides the rest.
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc(rpc, { p_match_id: matchId, ...extra });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }
    if (data === null) {
      throw new DomainError('NOT_AUTHORIZED');
    }

    outcome = data;
  } catch (error: unknown) {
    return actionFailure(error);
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

/**
 * "Cancel my spot", and withdrawal from the waitlist.
 *
 * Distinct from `markUnavailableAction`: this releases something the match was
 * relying on. The database classifies it on time or late from the match's own
 * cutoff and its own clock — no boolean, timestamp or classification travels
 * from the browser, so a crafted request cannot argue it was early.
 */
export async function cancelSpotAction(
  _previous: ActionResult<SignupOutcome> | null,
  formData: FormData,
): Promise<ActionResult<SignupOutcome>> {
  const rawReason = formData.get('reason');
  const reason =
    typeof rawReason === 'string' && rawReason.trim() !== ''
      ? z.string().max(500).parse(rawReason.trim())
      : null;

  return playerSignupAction('cancel_spot', formData, { p_reason: reason });
}

/**
 * Administrator promotion, for administrator-controlled leagues.
 *
 * With no membership id the database promotes its own recommendation, which is
 * the ordinary case. Naming somebody else is allowed but requires a reason —
 * F-09 says the administrator "may promote a different eligible player with an
 * audit note", so the note is a condition rather than decoration.
 */
export async function promoteWaitlistedPlayerAction(
  _previous: ActionResult<SignupOutcome> | null,
  formData: FormData,
): Promise<ActionResult<SignupOutcome>> {
  let matchId: string;
  let outcome: SignupOutcome;

  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    matchId = matchIdSchema.parse(formData.get('match_id') ?? '');

    const rawMembership = formData.get('membership_id');
    const membershipId =
      typeof rawMembership === 'string' && rawMembership !== ''
        ? z.uuid().parse(rawMembership)
        : null;

    const rawReason = formData.get('reason');
    const reason =
      typeof rawReason === 'string' && rawReason.trim() !== ''
        ? z.string().max(500).parse(rawReason.trim())
        : null;

    await requireLeagueAdmin(leagueId);

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc('promote_waitlisted_player', {
      p_match_id: matchId,
      p_membership_id: membershipId,
      p_reason: reason,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error, { SIGNUP_DECISION_INVALID: 'reason' });
    }

    outcome = data ?? { status: 'confirmed', waitlist_position: null };
  } catch (error: unknown) {
    return actionFailure(error);
  }

  revalidatePath('/', 'layout');
  return actionSuccess(outcome);
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

  revalidatePath('/', 'layout');
  return actionSuccess(revision);
}

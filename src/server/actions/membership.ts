'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireLeagueAdmin } from '@/lib/auth/authorization';
import { DASHBOARD_NOTICES, dashboardPathWithNotice } from '@/lib/auth/page-guards';
import { requireSessionUser } from '@/lib/auth/session';
import { actionFailure, actionSuccess, DomainError, type ActionResult } from '@/lib/errors';
import { domainErrorFromDatabase } from '@/lib/errors-from-database';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  decisionNoteSchema,
  joinRequestMessageSchema,
  memberEmailSchema,
  membershipStatusReasonSchema,
  membershipStatusSchema,
  suspendedUntilSchema,
} from '@/lib/validation/league';

/**
 * Join requests, manual member addition, membership status, and administrator
 * transfer.
 *
 * The pattern throughout: the client names a row, the server re-derives the
 * actor from the session, and the database function re-checks tenancy a second
 * time. Nothing here trusts a submitted user id, league id or role on its own.
 */

/** Submits — or re-returns — a request to join a searchable league. */
export async function requestToJoinLeagueAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    await requireSessionUser();

    const leagueId = z.uuid({ message: 'Choose a league.' }).parse(formData.get('league_id') ?? '');
    const message = joinRequestMessageSchema.parse(formData.get('message') ?? '');

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('request_to_join_league', {
      p_league_id: leagueId,
      p_message: message,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/leagues/discover');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/** Withdraws the caller's own pending request. Idempotent. */
export async function withdrawJoinRequestAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    await requireSessionUser();
    const requestId = z.uuid().parse(formData.get('request_id') ?? '');

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('withdraw_join_request', { p_request_id: requestId });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/leagues/discover');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/**
 * Approves or rejects a join request.
 *
 * Idempotent by construction: `decide_join_request()` returns the existing
 * membership when the request has already been decided, and the underlying
 * insert is an upsert on the `(league_id, user_id)` unique index — so a
 * double-click, a retried POST, or two administrators acting at once still
 * produce exactly one membership.
 *
 * Note the league id is *not* taken from the form. It is read from the request
 * row inside the database function, so a caller cannot pair a request from one
 * league with a league they happen to administer.
 */
export async function decideJoinRequestAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    await requireSessionUser();

    const requestId = z.uuid().parse(formData.get('request_id') ?? '');
    const decision = z.enum(['approve', 'reject']).parse(formData.get('decision') ?? '');
    const note = decisionNoteSchema.parse(formData.get('note') ?? '');

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('decide_join_request', {
      p_request_id: requestId,
      p_approve: decision === 'approve',
      p_note: note,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/** Adds an existing Matchday account to the league by email address. */
export async function addMemberByEmailAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    await requireLeagueAdmin(leagueId);

    const email = memberEmailSchema.safeParse(formData.get('email') ?? '');
    if (!email.success) {
      throw new DomainError('VALIDATION_FAILED', {
        fieldErrors: { email: 'Enter a valid email address.' },
      });
    }

    const status = z.enum(['active', 'pending']).parse(formData.get('status') ?? 'active');

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('add_league_member_by_email', {
      p_league_id: leagueId,
      p_email: email.data,
      p_status: status,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error, { PROFILE_NOT_FOUND: 'email' });
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/**
 * Changes a member's status (reactivate, suspend, remove).
 *
 * PHASE 7 MOVED THIS ONTO AN RPC. It used to be a direct UPDATE through the
 * Phase 1 policy, which recorded the change but did nothing else — the member
 * kept every spot they held in every future match, so a suspended player stayed
 * on the roster, stayed in the published teams and still consumed capacity.
 * `set_membership_status()` owns the whole transaction: the reason, the sole-
 * administrator refusal, and the cascade that releases those places, closes the
 * waitlist gap, promotes a replacement and republishes the teams.
 *
 * The reason and the suspension end date reach the database; neither is ever
 * placed in a notification, a push payload or an application log.
 */
export async function updateMembershipStatusAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    await requireLeagueAdmin(leagueId);

    const membershipId = z.uuid().parse(formData.get('membership_id') ?? '');
    const status = membershipStatusSchema.parse(formData.get('status') ?? '');
    const reason = membershipStatusReasonSchema.parse(formData.get('reason') ?? '');
    const suspendedUntil = suspendedUntilSchema.parse(formData.get('suspended_until') ?? '');

    // Asked for here so the administrator sees which field is wrong rather than
    // a whole-form message. The database refuses it again — this is a courtesy,
    // not the rule.
    if (status !== 'active' && reason === null) {
      throw new DomainError('VALIDATION_FAILED', {
        fieldErrors: { reason: 'Give a reason. Only administrators can see it.' },
      });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('set_membership_status', {
      p_membership_id: membershipId,
      p_status: status,
      p_reason: reason,
      // Only meaningful for a suspension, and the database clears it otherwise.
      p_suspended_until: status === 'suspended' ? suspendedUntil : null,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error, { VALIDATION_FAILED: 'reason' });
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/**
 * Ends the caller's own membership of a league.
 *
 * ── WHAT IT SENDS, AND WHAT IT DELIBERATELY DOES NOT ───────────────────────
 *
 * A league id. That is the entire payload. Every other membership action here
 * names a membership row, because an administrator is acting on somebody else;
 * this one is the caller acting on themselves, so `leave_league()` resolves the
 * membership from `auth.uid()` and the league. There is no membership id and no
 * user id in the form for anybody to substitute — a forged league id can only
 * name a league the caller does not belong to, which the database refuses.
 *
 * The two deliberate taps live in the sheet, not here. This action is the
 * second of them; it does not carry a confirmation token, because a token the
 * client always sends proves nothing about intent.
 *
 * ── ON SUCCESS THIS NAVIGATES AWAY, AND MUST ───────────────────────────────
 *
 * The same reasoning as `transferAdministrationAction`: the moment the
 * transaction commits the caller may be standing on a league route they are no
 * longer entitled to — the sheet opens from the app shell, so this can be
 * invoked from anywhere. `revalidatePath` alone would re-render that route
 * inside the action's own response, where its guard would fail and surface as
 * an error even though leaving had succeeded. The destination is a constant:
 * nothing about where to go next comes from the request.
 *
 * `revalidatePath` runs first so the dashboard renders from fresh membership
 * data, and both sit outside the try/catch because `redirect()` signals by
 * throwing.
 */
export async function leaveLeagueAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    await requireSessionUser();
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('leave_league', { p_league_id: leagueId });

    if (error !== null) {
      // `ADMIN_TRANSFER_INVALID` reaches the sheet as "That administration
      // transfer is not valid", which is true but unhelpful here. The
      // administrator case has its own copy in the menu and never renders a
      // Leave control, so this is the belt to that braces; the raw PostgreSQL
      // message is discarded either way.
      throw domainErrorFromDatabase(error);
    }
  } catch (error: unknown) {
    return actionFailure(error);
  }

  revalidatePath('/', 'layout');
  redirect(dashboardPathWithNotice(DASHBOARD_NOTICES.leftLeague));
}

/**
 * Hands administration to another active player, atomically.
 *
 * One RPC is one statement is one transaction. The database demotes the caller
 * and promotes the recipient in that order — the partial unique index is not
 * deferrable — and the deferred constraint re-asserts exactly one active
 * administrator at COMMIT. A failure at any point rolls back to the original
 * administrator; the league is never observable with zero or two.
 *
 * ON SUCCESS THIS NAVIGATES AWAY, AND MUST.
 *
 * This action is invoked from `/leagues/[slug]/members`, an administrator-only
 * route. The moment the transaction commits, the caller is a player and is no
 * longer entitled to the page they are standing on. `revalidatePath` alone
 * would re-render that very route inside the action's own response — the route
 * would then re-run its guard, fail, and surface as an unhandled error even
 * though the transfer had succeeded. Redirecting hands back a different route
 * instead of a forbidden one.
 *
 * The ordering matters twice over:
 *   * `revalidatePath` runs BEFORE `redirect`, so the dashboard renders from
 *     fresh membership data rather than the caller's stale administrator role;
 *   * both sit OUTSIDE the try/catch, because `redirect()` signals by throwing
 *     `NEXT_REDIRECT`. Inside the try, `actionFailure` would swallow that
 *     signal and quietly turn a successful transfer into a generic failure.
 */
export async function transferAdministrationAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    await requireLeagueAdmin(leagueId);

    const membershipId = z.uuid().parse(formData.get('membership_id') ?? '');
    const reason = decisionNoteSchema.parse(formData.get('reason') ?? '');

    // A transfer costs the caller their own administration, so require an
    // explicit confirmation rather than a single mis-click.
    if (formData.get('confirm') !== 'transfer') {
      throw new DomainError('VALIDATION_FAILED', {
        fieldErrors: { confirm: 'Type "transfer" to confirm handing over administration.' },
      });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('transfer_league_administration', {
      p_league_id: leagueId,
      p_target_membership_id: membershipId,
      p_reason: reason,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }
  } catch (error: unknown) {
    // A failed transfer leaves the caller an administrator, still on a page
    // they may view, so the error belongs in the form.
    return actionFailure(error);
  }

  revalidatePath('/', 'layout');
  redirect(dashboardPathWithNotice(DASHBOARD_NOTICES.administrationTransferred));
}

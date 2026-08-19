'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { deleteAvatarObjects, finalizeAndDeleteAuth } from '@/lib/account/deletion';
import { ACCOUNT_DELETED_PATH } from '@/lib/auth/page-guards';
import { getSessionUser } from '@/lib/auth/session';
import { actionFailure, actionSuccess, DomainError, type ActionResult } from '@/lib/errors';
import { domainErrorFromDatabase } from '@/lib/errors-from-database';
import { EMAIL_OTP_ERROR_MESSAGE, isValidEmailOtp, normalizeEmailOtp } from '@/lib/auth/otp';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Deleting your own MatchDay account, and closing a league in order to be able
 * to.
 *
 * ── THE SHAPE OF EVERY ACTION HERE ─────────────────────────────────────────
 *
 * None of them accepts a user id. The account is always the caller's own,
 * resolved from the session by the database function itself, so there is no
 * identifier in any form field for anybody to substitute. A forged league id in
 * `closeLeagueAction` can only name a league the caller does not administer,
 * which the database refuses.
 *
 * ── WHY THESE USE `getSessionUser()` AND NOT `requireSessionUser()` ────────
 *
 * `requireSessionUser()` now throws `ACCOUNT_DELETED` for an account whose
 * deletion has begun — which is right for every other action in the product and
 * exactly wrong here. Refusing to let somebody finish deleting their account on
 * the grounds that they are deleting their account is a trap with no way out,
 * and the retry path exists precisely for accounts already in that state.
 *
 * The database is unaffected by the distinction: `begin_my_account_deletion`
 * and `finalize_my_account_deletion` derive `auth.uid()` themselves and refuse
 * anonymous callers on their own.
 */

const passwordFieldSchema = z.string().min(1, { message: 'Enter your password.' });

/**
 * The emailed code, normalised the same way the sign-in form normalises it.
 *
 * Built from `@/lib/auth/otp` rather than re-typed: production issues
 * eight-digit codes and the first version of the sign-in schema hard-coded six,
 * which rejected every real one. Kept a string throughout, because coercing to
 * a number eats a leading zero.
 */
const deletionCodeSchema = z
  .string()
  .transform(normalizeEmailOtp)
  .refine(isValidEmailOtp, { message: EMAIL_OTP_ERROR_MESSAGE });

/**
 * Re-authentication, immediately before the first irreversible step.
 *
 * ── PROVING A PASSWORD BY USING IT ─────────────────────────────────────────
 *
 * The same technique `changePasswordAction` established: sign in with the
 * supplied password and see whether Supabase accepts it. MatchDay never reads
 * `auth.users.encrypted_password` and never needs the service role to find out
 * whether an account has one.
 *
 * ── AND THE ACCOUNTS THAT HAVE NO PASSWORD ─────────────────────────────────
 *
 * Email-code sign-in was kept as a secondary method, so passwordless accounts
 * exist and must not be told to type a password they never set. For them a
 * fresh emailed code is the equivalent proof: possession of the mailbox, now,
 * rather than at some point in the past.
 *
 * A failure here is reported identically for a wrong password, a wrong code and
 * an expired code.
 */
async function reauthenticate(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  email: string,
  formData: FormData,
): Promise<void> {
  const method = formData.get('method');

  if (method === 'code') {
    const token = deletionCodeSchema.safeParse(formData.get('token') ?? '');
    if (!token.success) {
      throw new DomainError('VALIDATION_FAILED', {
        fieldErrors: { token: EMAIL_OTP_ERROR_MESSAGE },
      });
    }

    const { error } = await supabase.auth.verifyOtp({
      email,
      token: token.data,
      type: 'email',
    });

    if (error !== null) {
      throw new DomainError('VALIDATION_FAILED', {
        cause: error,
        fieldErrors: { token: 'That code is not valid or has expired.' },
      });
    }
    return;
  }

  const password = passwordFieldSchema.safeParse(formData.get('password') ?? '');
  if (!password.success) {
    throw new DomainError('VALIDATION_FAILED', {
      fieldErrors: { password: 'Enter your password.' },
    });
  }

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password: password.data,
  });

  if (error !== null) {
    throw new DomainError('VALIDATION_FAILED', {
      cause: error,
      fieldErrors: {
        password:
          'That is not your password. If you have never set one, use the email code instead.',
      },
    });
  }
}

/** Sends the re-authentication code for an account with no password. */
export async function requestDeletionCodeAction(
  _previous: ActionResult<undefined> | null,
  _formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const user = await getSessionUser();
    if (user === null) {
      throw new DomainError('AUTH_REQUIRED');
    }

    const supabase = await createSupabaseServerClient();
    // `shouldCreateUser: false` because this address certainly exists — the
    // caller is signed in as it — and because a signed-in request must never be
    // able to mint an account.
    await supabase.auth.signInWithOtp({
      email: user.email,
      options: { shouldCreateUser: false },
    });

    // The result is discarded exactly as `requestSignInEmailAction` discards
    // it. There is nothing this caller could learn that they do not know.
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/**
 * The whole deletion, from re-authentication to a signed-out browser.
 *
 * ── THE ORDER IS THE DESIGN ────────────────────────────────────────────────
 *
 *   1. re-authenticate;
 *   2. `begin_my_account_deletion()` — refuses while an open league is
 *      administered, and stamps `deletion_started_at`. From here the account
 *      can do nothing at all, which is what makes step 3 terminate;
 *   3. empty the avatar folder. **On failure the whole thing stops**: a
 *      `deleted_at` stamped while a face is still served from a public URL
 *      would be the row promising something untrue;
 *   4. `finalize_my_account_deletion()` — one transaction, ending in the
 *      tombstone;
 *   5. delete the Auth user;
 *   6. sign out and land on the status page.
 *
 * Steps 2–5 are each idempotent, so a failure anywhere is answered by running
 * the same thing again — from the retry button, or from the reconciler.
 */
export async function deleteAccountAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const user = await getSessionUser();
    if (user === null) {
      throw new DomainError('AUTH_REQUIRED');
    }

    const supabase = await createSupabaseServerClient();

    await reauthenticate(supabase, user.email, formData);

    const { error: beginError } = await supabase.rpc('begin_my_account_deletion');
    if (beginError !== null) {
      throw domainErrorFromDatabase(beginError);
    }

    // The caller's own session, not the service role. Their storage policies
    // already permit exactly their own folder and nothing else, so RLS is the
    // proof of ownership rather than an application check that could be wrong.
    await deleteAvatarObjects(supabase, user.id);

    await finalizeAndDeleteAuth(async () => {
      const { error } = await supabase.rpc('finalize_my_account_deletion');
      if (error !== null) {
        throw domainErrorFromDatabase(error);
      }
    }, user.id);

    // Whatever happened to the Auth row, the local cookies must go: the account
    // is unusable either way, and leaving a session behind would put somebody
    // on a status page they cannot escape by signing out.
    await supabase.auth.signOut();
  } catch (error: unknown) {
    return actionFailure(error);
  }

  revalidatePath('/', 'layout');
  redirect(ACCOUNT_DELETED_PATH);
}

/**
 * Finishes a deletion that stopped part-way.
 *
 * The user-facing half of reconciliation. Somebody whose Storage call failed,
 * or whose Auth deletion did not land, arrives on the status page still signed
 * in; this lets them finish immediately rather than wait for the cron job to
 * come round. No re-authentication: they proved themselves to start, the
 * account is already unusable, and there is nothing here that a second proof
 * would protect.
 */
export async function retryAccountDeletionAction(
  _previous: ActionResult<undefined> | null,
  _formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const user = await getSessionUser();
    if (user === null) {
      throw new DomainError('AUTH_REQUIRED');
    }

    const supabase = await createSupabaseServerClient();

    // Both are no-ops when they have already happened, so this is safe however
    // far the original attempt got.
    await deleteAvatarObjects(supabase, user.id);

    await finalizeAndDeleteAuth(async () => {
      const { error } = await supabase.rpc('finalize_my_account_deletion');
      if (error !== null) {
        throw domainErrorFromDatabase(error);
      }
    }, user.id);

    await supabase.auth.signOut();
  } catch (error: unknown) {
    return actionFailure(error);
  }

  revalidatePath('/', 'layout');
  redirect(ACCOUNT_DELETED_PATH);
}

/**
 * Closes a league so that its administrator can delete their account.
 *
 * Offered to every administrator rather than only to those with nobody to
 * transfer to. Winding a league down is a legitimate decision, and conscripting
 * a successor purely to escape your own account deletion is not a choice the
 * product should force.
 *
 * Deliberately reachable only from the deletion flow. There is no
 * general-purpose league-closure screen and no reopen path in this release.
 */
export async function closeLeagueAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const user = await getSessionUser();
    if (user === null) {
      throw new DomainError('AUTH_REQUIRED');
    }

    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');

    // Typed confirmation, as `transferAdministrationAction` requires for the
    // other irreversible thing an administrator can do to a league. Closing
    // cancels every future match for everybody in it, which is not an outcome
    // a mis-tap should be able to produce.
    if (formData.get('confirm') !== 'close') {
      throw new DomainError('VALIDATION_FAILED', {
        fieldErrors: { confirm: 'Type "close" to confirm closing this league.' },
      });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('close_league', { p_league_id: leagueId });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { EMAIL_OTP_ERROR_MESSAGE, isValidEmailOtp, normalizeEmailOtp } from '@/lib/auth/otp';
import { ONBOARDING_PATH } from '@/lib/auth/page-guards';
import { safeRedirectPath } from '@/lib/auth/safe-redirect';
import { getCurrentProfile } from '@/lib/auth/session';
import { getSiteUrl } from '@/lib/env';
import { actionFailure, actionSuccess, DomainError, type ActionResult } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  emailSchema,
  newPasswordSchema,
  passwordSchema,
  signInSchema,
  signUpSchema,
  SIGN_IN_FAILURE_MESSAGE,
} from '@/lib/validation/password';
import { toFieldErrors } from '@/lib/validation/profile';

/**
 * Email and password authentication.
 *
 * ── WHAT IS AND IS NOT LOGGED ──────────────────────────────────────────────
 *
 * Nothing in this file logs. A password, a one-time code and a recovery token
 * are all live credentials, and the cheapest way to guarantee none of them
 * reaches an observability sink is for these actions never to call one.
 * `src/lib/observability/log.ts` would drop a `password` or `token` key anyway;
 * this simply never offers one.
 *
 * ── NON-ENUMERATION IS A DESIGN CONSTRAINT, NOT A NICETY ───────────────────
 *
 * A form that answers "no such account" differently from "wrong password" is an
 * account-existence oracle, and MatchDay's accounts are people's real email
 * addresses. Supabase already collapses the two — verified: both return
 * `Invalid login credentials`, status 400 — and the actions below are careful
 * not to reintroduce the distinction on the paths where Supabase *does* leak
 * it, which are signup (`User already registered`, 422) and code sign-in
 * (`Signups not allowed for otp`, 422).
 */

/** Where somebody lands once they are authenticated. */
async function postAuthDestination(next: string): Promise<string> {
  // A brand-new account has no profile row yet, and the authenticated layout
  // would bounce them to onboarding on arrival anyway. Sending them straight
  // there saves a redirect and a flash of a page they cannot use.
  const profile = await getCurrentProfile();
  return profile === null ? ONBOARDING_PATH : next;
}

function readNext(formData: FormData): string {
  return safeRedirectPath(
    typeof formData.get('next') === 'string' ? String(formData.get('next')) : null,
  );
}

// ── Signing in ─────────────────────────────────────────────────────────────

/**
 * The ordinary way in: email and password, no email sent.
 */
export async function signInWithPasswordAction(
  _previous: ActionResult<never> | null,
  formData: FormData,
): Promise<ActionResult<never>> {
  const parsed = signInSchema.safeParse({
    email: formData.get('email') ?? '',
    password: formData.get('password') ?? '',
  });

  // Even a malformed email gets the generic message rather than a field-level
  // "that is not an email": the shape of the answer must not depend on the
  // input, or the form starts telling people things.
  if (!parsed.success) {
    return actionFailure(
      new DomainError('VALIDATION_FAILED', {
        fieldErrors: { form: SIGN_IN_FAILURE_MESSAGE },
      }),
    );
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error !== null) {
    // Wrong password, unknown account, and an account that exists but has not
    // confirmed its email all land here with one message. The third is the one
    // worth noting: Supabase answers `Email not confirmed`, which would
    // otherwise confirm the address is registered.
    return actionFailure(
      new DomainError('VALIDATION_FAILED', {
        cause: error,
        fieldErrors: { form: SIGN_IN_FAILURE_MESSAGE },
      }),
    );
  }

  redirect(await postAuthDestination(readNext(formData)));
}

// ── Creating an account ────────────────────────────────────────────────────

export interface SignUpState {
  email: string;
}

/**
 * Creating an account.
 *
 * With email confirmations enabled — which production must be, see the rollout
 * checklist — this creates the `auth.users` row but returns **no session**.
 * The account cannot reach anything protected until the address is confirmed,
 * which is the point.
 *
 * ── THE DUPLICATE-EMAIL ORACLE ─────────────────────────────────────────────
 *
 * Supabase answers a second signup for a confirmed address with `User already
 * registered` (422). Surfacing that would turn this form into a way to test
 * whether somebody has a MatchDay account. So a duplicate produces exactly the
 * same screen as a fresh signup, and the email that does or does not arrive is
 * what resolves it — for the person who owns the inbox, and for nobody else.
 */
export async function signUpWithPasswordAction(
  _previous: ActionResult<SignUpState> | null,
  formData: FormData,
): Promise<ActionResult<SignUpState>> {
  const parsed = signUpSchema.safeParse({
    email: formData.get('email') ?? '',
    password: formData.get('password') ?? '',
    confirm_password: formData.get('confirm_password') ?? '',
  });

  if (!parsed.success) {
    return actionFailure(
      new DomainError('VALIDATION_FAILED', { fieldErrors: toFieldErrors(parsed.error) }),
    );
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      // Only the legacy `{{ .ConfirmationURL }}` templates read this. The
      // token-hash templates point at `/auth/continue` directly, so it is
      // belt-and-braces during the template rollout.
      emailRedirectTo: `${getSiteUrl()}/auth/callback`,
    },
  });

  // Two answers are deliberately swallowed, because both are oracles:
  //
  //   * 422 `User already registered` — says the address has an account;
  //   * 429 the per-address frequency limit — says an email was sent to this
  //     address recently, which says the same thing more slowly.
  //
  // Genuine failures — a password Supabase rejects, the service being down —
  // are not swallowed, because the person needs to know their account was not
  // created.
  if (error !== null && error.status !== 422 && error.status !== 429) {
    return actionFailure(
      new DomainError('VALIDATION_FAILED', {
        cause: error,
        fieldErrors: { form: 'We could not create that account. Try again in a moment.' },
      }),
    );
  }

  return actionSuccess({ email: parsed.data.email });
}

/**
 * Confirming a signup with the code from the email.
 *
 * The type is `signup`, determined empirically against the installed SDK rather
 * than from documentation: `verifyOtp({ email, token, type: 'signup' })` is what
 * accepts the `{{ .Token }}` a confirmation email carries. `magiclink` and
 * `email` both refuse it.
 */
export async function verifySignUpCodeAction(
  _previous: ActionResult<never> | null,
  formData: FormData,
): Promise<ActionResult<never>> {
  const email = emailSchema.safeParse(formData.get('email') ?? '');
  const rawToken = typeof formData.get('token') === 'string' ? String(formData.get('token')) : '';
  const token = normalizeEmailOtp(rawToken);

  if (!email.success || !isValidEmailOtp(token)) {
    return actionFailure(
      new DomainError('VALIDATION_FAILED', {
        fieldErrors: { token: EMAIL_OTP_ERROR_MESSAGE },
      }),
    );
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({
    email: email.data,
    token,
    type: 'signup',
  });

  if (error !== null) {
    return actionFailure(
      new DomainError('VALIDATION_FAILED', {
        cause: error,
        fieldErrors: { token: 'That code is not valid or has expired.' },
      }),
    );
  }

  redirect(await postAuthDestination(readNext(formData)));
}

/**
 * Sending the confirmation email again.
 *
 * `resend` rather than a second `signUp`: signing up twice would either fail on
 * the duplicate or, worse, be interpreted as a password change attempt.
 *
 * Always reports success. An address with nothing to resend must look exactly
 * like one that got a new email.
 */
export async function resendSignUpEmailAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  const email = emailSchema.safeParse(formData.get('email') ?? '');

  if (!email.success) {
    return actionSuccess();
  }

  const supabase = await createSupabaseServerClient();
  // Errors are deliberately ignored, including the per-address frequency limit
  // Supabase applies. Reporting "you asked too recently" would confirm that an
  // email had been sent, which is the same oracle by another route.
  await supabase.auth.resend({ type: 'signup', email: email.data });

  return actionSuccess();
}

// ── Forgotten, or never had, a password ────────────────────────────────────

/**
 * Requesting a recovery email.
 *
 * Serves two groups with one flow: people who forgot a password, and the
 * historical passwordless accounts that never had one. Verified against the
 * installed SDK that recovery works for the second group — a user with no
 * `encrypted_password` receives the email, verifies, and can set one.
 *
 * Always reports success, whatever happened. This form is the most obvious
 * account-existence oracle in the product if it does not.
 */
export async function requestPasswordResetAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  const email = emailSchema.safeParse(formData.get('email') ?? '');

  if (email.success) {
    const supabase = await createSupabaseServerClient();
    // `redirectTo` is only read by a legacy-shaped template. The recovery
    // template points at `/auth/continue?...&type=recovery`, which needs no
    // redirect parameter at all.
    await supabase.auth.resetPasswordForEmail(email.data, {
      redirectTo: `${getSiteUrl()}/auth/callback`,
    });
  }

  return actionSuccess();
}

/**
 * Setting a password from a recovery session.
 *
 * The session already exists by the time this runs — `/auth/continue` verified
 * the recovery token and the SSR client wrote the cookies. So this is an
 * ordinary authenticated `updateUser`, and Supabase applies it to whichever
 * user that session belongs to. No email, no token, no user id crosses the
 * wire.
 */
export async function setPasswordAction(
  _previous: ActionResult<never> | null,
  formData: FormData,
): Promise<ActionResult<never>> {
  const parsed = newPasswordSchema.safeParse({
    password: formData.get('password') ?? '',
    confirm_password: formData.get('confirm_password') ?? '',
  });

  if (!parsed.success) {
    return actionFailure(
      new DomainError('VALIDATION_FAILED', { fieldErrors: toFieldErrors(parsed.error) }),
    );
  }

  const supabase = await createSupabaseServerClient();

  // Without a session this is not a recovery link, it is somebody at the URL.
  const { data: sessionUser } = await supabase.auth.getUser();
  if (sessionUser.user === null) {
    return actionFailure(
      new DomainError('AUTH_REQUIRED', {
        fieldErrors: { form: 'That reset link has expired. Ask for a new one.' },
      }),
    );
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });

  if (error !== null) {
    return actionFailure(
      new DomainError('VALIDATION_FAILED', {
        cause: error,
        fieldErrors: { password: 'We could not set that password. Try a different one.' },
      }),
    );
  }

  redirect(await postAuthDestination(readNext(formData)));
}

// ── Changing a password from inside the app ────────────────────────────────

const changePasswordSchema = z.object({
  current_password: z.string().min(1, { message: 'Enter your current password.' }),
  // `passwordSchema` directly, not reached through `newPasswordSchema` — that
  // one is a ZodEffects after its `superRefine`, so `.shape` is undefined and
  // the minimum length would have silently disappeared.
  password: passwordSchema,
  confirm_password: z.string(),
});

/**
 * Changing a password while signed in.
 *
 * ── WHY THE CURRENT PASSWORD IS CHECKED HERE AND NOT BY SUPABASE ───────────
 *
 * Supabase can enforce it globally with `secure_password_change`, and that
 * setting is deliberately **off**. Turning it on would require a current
 * password for *every* update — including the first one a historical
 * passwordless account ever sets, which by definition it does not have. It
 * would lock every pre-password member out of the migration this stage exists
 * to provide.
 *
 * So the check lives here, where it can apply to the case it is for. The
 * current password is verified by using it: `signInWithPassword` against the
 * signed-in user's own address either works or does not. That is not a
 * side-channel — the caller already holds a session for that account — and it
 * means MatchDay never needs to know whether a password exists, never reads
 * `auth.users`, and never needs the service role to find out.
 *
 * An account with no password simply cannot produce a matching current one, so
 * it is routed to the recovery flow instead. See `/profile`.
 */
export async function changePasswordAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  const parsed = changePasswordSchema.safeParse({
    current_password: formData.get('current_password') ?? '',
    password: formData.get('password') ?? '',
    confirm_password: formData.get('confirm_password') ?? '',
  });

  if (!parsed.success) {
    return actionFailure(
      new DomainError('VALIDATION_FAILED', { fieldErrors: toFieldErrors(parsed.error) }),
    );
  }

  if (parsed.data.password !== parsed.data.confirm_password) {
    return actionFailure(
      new DomainError('VALIDATION_FAILED', {
        fieldErrors: { confirm_password: 'Both passwords must match.' },
      }),
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data: sessionUser } = await supabase.auth.getUser();

  if (sessionUser.user === null || typeof sessionUser.user.email !== 'string') {
    return actionFailure(new DomainError('AUTH_REQUIRED'));
  }

  // Proving the current password by using it. A failure here is either a wrong
  // password or an account that has never had one; both mean the same thing to
  // this form, and the message says what to do about it.
  const { error: reauth } = await supabase.auth.signInWithPassword({
    email: sessionUser.user.email,
    password: parsed.data.current_password,
  });

  if (reauth !== null) {
    return actionFailure(
      new DomainError('VALIDATION_FAILED', {
        cause: reauth,
        fieldErrors: {
          current_password:
            'That is not your current password. If you have never set one, use the email link below.',
        },
      }),
    );
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });

  if (error !== null) {
    return actionFailure(
      new DomainError('VALIDATION_FAILED', {
        cause: error,
        fieldErrors: { password: 'We could not set that password. Try a different one.' },
      }),
    );
  }

  return actionSuccess();
}

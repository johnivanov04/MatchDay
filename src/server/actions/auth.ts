'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  EMAIL_OTP_ERROR_MESSAGE,
  isValidEmailOtp,
  normalizeEmailOtp,
} from '@/lib/auth/otp';
import { safeRedirectPath } from '@/lib/auth/safe-redirect';
import { getSiteUrl } from '@/lib/env';
import { actionFailure, actionSuccess, DomainError, type ActionResult } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const emailSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.email({ message: 'Enter a valid email address.' }));

/**
 * The emailed one-time code.
 *
 * Six to ten digits, because that is the range Supabase's email OTP length
 * setting spans and production is configured for eight. It was `\d{6}`, which
 * rejected every production code outright.
 *
 * Stays a string throughout — see `@/lib/auth/otp`. Coercing to a number would
 * eat a leading zero and silently send the wrong code to Supabase.
 */
const otpSchema = z
  .string()
  .transform(normalizeEmailOtp)
  .refine(isValidEmailOtp, { message: EMAIL_OTP_ERROR_MESSAGE });

export interface SignInState {
  email: string;
}

/**
 * Sends a sign-in email containing both a prefetch-safe link and a one-time
 * code, for somebody who would rather not type a password on a phone.
 *
 * ── IT NO LONGER CREATES ACCOUNTS ──────────────────────────────────────────
 *
 * `shouldCreateUser: false`, which is the whole behavioural change here. This
 * used to be the *only* way in, so it had to create the account as a side
 * effect of asking to sign in. Now that Create account exists, an address
 * nobody has registered typing itself into this box is a mistake, not a signup
 * — and silently minting an `auth.users` row for it left half-made accounts
 * behind that could never be used.
 *
 * Verified against the installed SDK: with the flag off, an unknown address
 * produces `Signups not allowed for otp` (422), **no user row and no email**.
 *
 * ── AND STILL REPORTS SUCCESS ──────────────────────────────────────────────
 *
 * That 422 is an account-existence oracle, so it never reaches the caller. Both
 * a known and an unknown address get the same "check your email" screen; only
 * the person holding the inbox learns which it was.
 */
export async function requestSignInEmailAction(
  _previous: ActionResult<SignInState> | null,
  formData: FormData,
): Promise<ActionResult<SignInState>> {
  const parsed = emailSchema.safeParse(formData.get('email') ?? '');

  if (!parsed.success) {
    return actionFailure(
      new DomainError('VALIDATION_FAILED', {
        fieldErrors: { email: parsed.error.issues[0]?.message ?? 'Enter a valid email address.' },
      }),
    );
  }

  // Where to land after authenticating — an invitation link, usually. Passed
  // through `safeRedirectPath` here as well as in the callback, so a crafted
  // value cannot even be placed into the outgoing email.
  const next = safeRedirectPath(
    typeof formData.get('next') === 'string' ? String(formData.get('next')) : null,
  );

  const supabase = await createSupabaseServerClient();
  await supabase.auth.signInWithOtp({
    email: parsed.data,
    options: {
      shouldCreateUser: false,
      // Built from configuration, never from the request Host header. Only the
      // legacy `{{ .ConfirmationURL }}` templates read it.
      emailRedirectTo: `${getSiteUrl()}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });

  // The result is deliberately discarded. `Signups not allowed for otp` means
  // the address has no account, and saying so would answer a question this form
  // must not answer.
  return actionSuccess({ email: parsed.data });
}

/**
 * Exchanges an emailed one-time code for a session.
 *
 * The code is never logged, here or anywhere: it is a live credential until it
 * is spent.
 */
export async function verifySignInCodeAction(
  _previous: ActionResult<never> | null,
  formData: FormData,
): Promise<ActionResult<never>> {
  const email = emailSchema.safeParse(formData.get('email') ?? '');
  const token = otpSchema.safeParse(formData.get('token') ?? '');

  if (!email.success || !token.success) {
    return actionFailure(
      new DomainError('VALIDATION_FAILED', {
        fieldErrors: {
          ...(email.success ? {} : { email: 'Enter a valid email address.' }),
          ...(token.success
            ? {}
            : { token: token.error?.issues[0]?.message ?? EMAIL_OTP_ERROR_MESSAGE }),
        },
      }),
    );
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({
    email: email.data,
    token: token.data,
    type: 'email',
  });

  if (error !== null) {
    // A wrong code and an expired code are reported identically.
    return actionFailure(
      new DomainError('VALIDATION_FAILED', {
        cause: error,
        fieldErrors: { token: 'That code is not valid or has expired.' },
      }),
    );
  }

  redirect(
    safeRedirectPath(
      typeof formData.get('next') === 'string' ? String(formData.get('next')) : null,
    ),
  );
}

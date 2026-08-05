'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { safeRedirectPath } from '@/lib/auth/safe-redirect';
import { getSiteUrl } from '@/lib/env';
import { actionFailure, actionSuccess, DomainError, type ActionResult } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const emailSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.email({ message: 'Enter a valid email address.' }));

const otpSchema = z
  .string()
  .transform((value) => value.replaceAll(/\s/g, ''))
  .refine((value) => /^\d{6}$/.test(value), { message: 'Enter the 6-digit code from your email.' });

export interface SignInState {
  email: string;
}

/**
 * Sends a sign-in email containing both a magic link and a one-time code
 * (02 §2: "Supabase Auth using email magic link or one-time code").
 *
 * Always reports success. Reporting "no such account" would turn this form into
 * an account-existence oracle, and with `shouldCreateUser` enabled there is no
 * such distinction to leak anyway.
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
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data,
    options: {
      shouldCreateUser: true,
      // Built from configuration, never from the request Host header.
      emailRedirectTo: `${getSiteUrl()}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });

  if (error !== null) {
    return actionFailure(new DomainError('AUTH_REQUIRED', { cause: error }));
  }

  return actionSuccess({ email: parsed.data });
}

/** Exchanges a 6-digit one-time code for a session. */
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
            : { token: token.error?.issues[0]?.message ?? 'Enter the 6-digit code.' }),
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

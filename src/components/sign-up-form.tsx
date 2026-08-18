'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { Field, FormError, inputClassName, SubmitButton } from '@/components/ui/field';
import { CheckIcon } from '@/components/ui/icon';
import { PasswordField } from '@/components/ui/password-field';
import { EMAIL_OTP_INPUT_PATTERN, EMAIL_OTP_MAX_LENGTH } from '@/lib/auth/otp';
import { PASSWORD_REQUIREMENT_TEXT } from '@/lib/validation/password';
import {
  resendSignUpEmailAction,
  signUpWithPasswordAction,
  verifySignUpCodeAction,
} from '@/server/actions/auth-password';

/**
 * Creating an account.
 *
 * Two screens in one component: the form, and the "check your email" state it
 * becomes. They share the address, which is the only thing that has to survive
 * between them, and keeping them together means it cannot be lost to a
 * navigation.
 *
 * ── WHAT THE SECOND SCREEN OFFERS ──────────────────────────────────────────
 *
 * Both ways of confirming, because people's mail clients differ: tap the link
 * in the email — which works on any device since Stage 2 — or type the code
 * into the field here. The code path exists for the mail app that strips links
 * and for the person reading their email on a different machine.
 */
export function SignUpForm({ nextPath }: { nextPath: string }) {
  const [state, submit, pending] = useActionState(signUpWithPasswordAction, null);

  const fieldError = (field: string): string | undefined =>
    state?.ok === false ? state.fieldErrors[field] : undefined;

  if (state?.ok === true) {
    return <CheckYourEmail email={state.data.email} nextPath={nextPath} />;
  }

  return (
    <div className="flex flex-col gap-5">
      <form action={submit} className="flex flex-col gap-4">
        <input type="hidden" name="next" value={nextPath} />
        <FormError message={fieldError('form')} />

        <Field label="Email address" htmlFor="email" error={fieldError('email')}>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            required
            className={inputClassName}
          />
        </Field>

        <PasswordField
          label="Password"
          name="password"
          autoComplete="new-password"
          hint={PASSWORD_REQUIREMENT_TEXT}
          error={fieldError('password')}
        />

        <PasswordField
          label="Confirm password"
          name="confirm_password"
          autoComplete="new-password"
          error={fieldError('confirm_password')}
        />

        <SubmitButton pending={pending}>Create account</SubmitButton>
      </form>

      <p className="text-center text-sm text-muted">
        Already have an account?{' '}
        <Link href="/sign-in" className="font-semibold underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </div>
  );
}

function CheckYourEmail({ email, nextPath }: { email: string; nextPath: string }) {
  const [codeState, verify, verifying] = useActionState(verifySignUpCodeAction, null);
  const [resendState, resend, resending] = useActionState(resendSignUpEmailAction, null);
  const [resentAt, setResentAt] = useState<number | null>(null);

  // A plain "sent" acknowledgement rather than a countdown timer. Supabase
  // applies its own per-address frequency limit, and a client-side clock would
  // only be guessing at it — while a second press that quietly does nothing is
  // exactly the spam-click this is meant to discourage.
  const justResent = resendState?.ok === true && resentAt !== null;

  return (
    <div className="animate-rise flex flex-col gap-5">
      <div className="flex flex-col items-center gap-2 text-center">
        <span
          aria-hidden="true"
          className="animate-pop inline-flex h-12 w-12 items-center justify-center rounded-full bg-pitch-50 text-pitch-600 dark:bg-pitch-900/50 dark:text-pitch-300"
        >
          <CheckIcon size={24} />
        </span>
        <h2 className="text-lg font-bold">Check your email</h2>
        <p className="text-sm leading-relaxed text-secondary">
          We sent a confirmation to <strong>{email}</strong>. Tap the button in that email — it
          works on any device — or enter the code from it below.
        </p>
      </div>

      <form action={verify} className="flex flex-col gap-4">
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="next" value={nextPath} />
        <FormError message={codeState?.ok === false ? codeState.fieldErrors['form'] : undefined} />
        <Field
          label="Confirmation code"
          htmlFor="signup-token"
          error={codeState?.ok === false ? codeState.fieldErrors['token'] : undefined}
        >
          <input
            id="signup-token"
            name="token"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern={EMAIL_OTP_INPUT_PATTERN}
            maxLength={EMAIL_OTP_MAX_LENGTH}
            required
            className={`${inputClassName} tracking-[0.25em]`}
          />
        </Field>
        <SubmitButton pending={verifying}>Confirm email</SubmitButton>
      </form>

      <form
        action={resend}
        onSubmit={() => {
          setResentAt(Date.now());
        }}
        className="flex flex-col gap-2"
      >
        <input type="hidden" name="email" value={email} />
        <button
          type="submit"
          disabled={resending || justResent}
          className="press min-h-control text-sm underline underline-offset-4 disabled:no-underline disabled:opacity-55"
        >
          {resending ? 'Sending…' : justResent ? 'Confirmation sent' : 'Send the email again'}
        </button>
      </form>

      <p className="text-center text-sm text-muted">
        Wrong address?{' '}
        <Link href="/sign-up" className="font-semibold underline underline-offset-4">
          Start again
        </Link>
      </p>
    </div>
  );
}

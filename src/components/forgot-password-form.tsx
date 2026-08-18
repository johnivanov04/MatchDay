'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Field, FormError, inputClassName, SubmitButton } from '@/components/ui/field';
import { CheckIcon } from '@/components/ui/icon';
import { requestPasswordResetAction } from '@/server/actions/auth-password';

/**
 * Asking for a recovery email.
 *
 * ── THE ANSWER NEVER DEPENDS ON THE ADDRESS ────────────────────────────────
 *
 * This is the most obvious account-existence oracle a product has: type an
 * address, and a form that says "no such account" has told you whether somebody
 * is a MatchDay member. So the acknowledgement below is rendered on success
 * *whatever happened* — the action does not report which case it was, and
 * cannot, because it does not look.
 *
 * The wording carries the ambiguity honestly rather than implying an email is
 * definitely on its way. "If an account exists" is not weasel wording here; it
 * is the literal truth about what we know.
 */
export function ForgotPasswordForm() {
  const [state, submit, pending] = useActionState(requestPasswordResetAction, null);

  if (state?.ok === true) {
    return (
      <div className="animate-rise flex flex-col items-center gap-3 text-center">
        <span
          aria-hidden="true"
          className="animate-pop inline-flex h-12 w-12 items-center justify-center rounded-full bg-pitch-50 text-pitch-600 dark:bg-pitch-900/50 dark:text-pitch-300"
        >
          <CheckIcon size={24} />
        </span>
        <h3 className="text-lg font-bold">Check your email</h3>
        <p role="status" className="text-sm leading-relaxed text-secondary">
          If an account exists for that email, we have sent password reset instructions. The link
          works on any device and can only be used once.
        </p>
        <Link href="/sign-in" className="text-sm underline underline-offset-4">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <form action={submit} className="flex flex-col gap-4">
        <FormError message={state?.ok === false ? state.fieldErrors['form'] : undefined} />
        <Field
          label="Email address"
          htmlFor="email"
          hint="We will send a link that lets you choose a new password."
        >
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
        <SubmitButton pending={pending}>Send recovery email</SubmitButton>
      </form>

      <p className="text-center text-sm text-muted">
        Remembered it?{' '}
        <Link href="/sign-in" className="font-semibold underline underline-offset-4">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

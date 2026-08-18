'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { Field, FormError, inputClassName, SubmitButton } from '@/components/ui/field';
import { CheckIcon } from '@/components/ui/icon';
import { PasswordField } from '@/components/ui/password-field';
import { EMAIL_OTP_INPUT_PATTERN, EMAIL_OTP_MAX_LENGTH } from '@/lib/auth/otp';
import { requestSignInEmailAction, verifySignInCodeAction } from '@/server/actions/auth';
import { signInWithPasswordAction } from '@/server/actions/auth-password';

/**
 * Signing in.
 *
 * ── PASSWORD FIRST, CODE STILL THERE ───────────────────────────────────────
 *
 * A password is the fast path: it is instant, it works offline of the mail
 * round trip, and a password manager fills it. So it is what the screen opens
 * on.
 *
 * The one-time code stays, deliberately and permanently, because it is genuinely
 * better on a phone at the side of a pitch — no password to remember, no manager
 * to fight. It is secondary, not deprecated.
 *
 * ── ONE FAILURE MESSAGE ────────────────────────────────────────────────────
 *
 * Wrong password, unknown address and unconfirmed account all say "Email or
 * password is incorrect." Supabase already answers the first two identically;
 * this form is careful not to reintroduce the difference, because the addresses
 * involved are people's real ones.
 */
export function SignInForm({ nextPath }: { nextPath: string }) {
  const [mode, setMode] = useState<'password' | 'code'>('password');

  return mode === 'password' ? (
    <PasswordSignIn nextPath={nextPath} onUseCode={() => setMode('code')} />
  ) : (
    <CodeSignIn nextPath={nextPath} onUsePassword={() => setMode('password')} />
  );
}

function PasswordSignIn({
  nextPath,
  onUseCode,
}: {
  nextPath: string;
  onUseCode: () => void;
}) {
  const [state, submit, pending] = useActionState(signInWithPasswordAction, null);
  const fieldError = (field: string): string | undefined =>
    state?.ok === false ? state.fieldErrors[field] : undefined;

  return (
    <div className="flex flex-col gap-5">
      <form action={submit} className="flex flex-col gap-4">
        <input type="hidden" name="next" value={nextPath} />
        <FormError message={fieldError('form')} />

        <Field label="Email address" htmlFor="email">
          <input
            id="email"
            name="email"
            type="email"
            // `username`, not `email`: it is what pairs with `current-password`
            // for a password manager, and what makes it offer to save the two
            // together after a successful sign-in.
            autoComplete="username"
            inputMode="email"
            required
            className={inputClassName}
          />
        </Field>

        <PasswordField label="Password" name="password" autoComplete="current-password" />

        <SubmitButton pending={pending}>Sign in</SubmitButton>
      </form>

      <div className="flex flex-col gap-3 text-sm">
        <Link href="/forgot-password" className="underline underline-offset-4">
          Forgot or don&rsquo;t have a password?
        </Link>

        {/* A real separator, not a heading: what follows is an alternative way
            to do the same thing, not a different task. */}
        <div className="flex items-center gap-3 py-1" aria-hidden="true">
          <span className="h-px flex-1 bg-[var(--border-subtle)]" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">or</span>
          <span className="h-px flex-1 bg-[var(--border-subtle)]" />
        </div>

        <button
          type="button"
          onClick={onUseCode}
          className="press inline-flex min-h-control w-full items-center justify-center rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-4 py-2.5 text-sm font-semibold hover:bg-[var(--surface-hover)]"
        >
          Sign in with a code instead
        </button>

        <p className="text-center text-muted">
          Don&rsquo;t have an account?{' '}
          <Link href="/sign-up" className="font-semibold underline underline-offset-4">
            Create account
          </Link>
        </p>
      </div>
    </div>
  );
}

/**
 * The code path.
 *
 * THE CODE IS NOT SIX DIGITS. Supabase's email OTP length is configurable from
 * 6 to 10, and production is configured for eight. This form once used
 * `maxLength={6}`, so the browser silently refused the last two characters of
 * every real code and signing in by code was impossible on production. The
 * bounds now come from `@/lib/auth/otp`, which the server validator reads too,
 * so the two cannot drift apart again.
 *
 * The email this sends also carries the prefetch-safe `/auth/continue` link, so
 * somebody who would rather tap than type still can — including on a different
 * device, which is what Stage 2 fixed.
 */
function CodeSignIn({
  nextPath,
  onUsePassword,
}: {
  nextPath: string;
  onUsePassword: () => void;
}) {
  const [emailState, submitEmail, sendingEmail] = useActionState(requestSignInEmailAction, null);
  const [codeState, submitCode, verifyingCode] = useActionState(verifySignInCodeAction, null);

  const sentTo = emailState?.ok === true ? emailState.data.email : null;

  if (sentTo !== null) {
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
            If <strong>{sentTo}</strong> has a MatchDay account, we have sent it a sign-in link and
            a one-time code. Tap the link on any device, or enter the code below.
          </p>
        </div>

        <form action={submitCode} className="flex flex-col gap-4">
          <input type="hidden" name="email" value={sentTo} />
          <input type="hidden" name="next" value={nextPath} />
          <FormError
            message={codeState?.ok === false ? codeState.fieldErrors['form'] : undefined}
          />
          <Field
            label="One-time code"
            htmlFor="token"
            error={codeState?.ok === false ? codeState.fieldErrors['token'] : undefined}
          >
            <input
              id="token"
              name="token"
              inputMode="numeric"
              autoComplete="one-time-code"
              // Both derived from the same constants the server validates with.
              pattern={EMAIL_OTP_INPUT_PATTERN}
              maxLength={EMAIL_OTP_MAX_LENGTH}
              required
              className={`${inputClassName} tracking-[0.25em]`}
            />
          </Field>
          <SubmitButton pending={verifyingCode}>Sign in</SubmitButton>
        </form>

        <button
          type="button"
          onClick={onUsePassword}
          className="press min-h-control text-sm underline underline-offset-4"
        >
          Use my password instead
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <form action={submitEmail} className="flex flex-col gap-4">
        <input type="hidden" name="next" value={nextPath} />
        <FormError message={emailState?.ok === false ? emailState.fieldErrors['form'] : undefined} />
        <Field
          label="Email address"
          htmlFor="email"
          hint="We will email you a sign-in link and a one-time code."
          error={emailState?.ok === false ? emailState.fieldErrors['email'] : undefined}
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
        <SubmitButton pending={sendingEmail}>Email me a sign-in link</SubmitButton>
      </form>

      <button
        type="button"
        onClick={onUsePassword}
        className="press min-h-control text-sm underline underline-offset-4"
      >
        Use my password instead
      </button>
    </div>
  );
}

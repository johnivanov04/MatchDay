'use client';

import { useActionState, useState } from 'react';
import { Field, FormError, inputClassName, SubmitButton } from '@/components/ui/field';
import { EMAIL_OTP_INPUT_PATTERN, EMAIL_OTP_MAX_LENGTH } from '@/lib/auth/otp';
import { requestSignInEmailAction, verifySignInCodeAction } from '@/server/actions/auth';

/**
 * Email-only sign-in. The same email carries a magic link and a one-time code,
 * so a player who opens their mail on a different device is not stuck.
 *
 * THE CODE IS NOT SIX DIGITS. Supabase's email OTP length is configurable from
 * 6 to 10, and production sends eight. This form used `maxLength={6}`, so the
 * browser silently refused the last two characters of every real code and
 * signing in by code was impossible on production. The bounds now come from
 * `@/lib/auth/otp`, which the server validator reads too, so the two cannot
 * drift apart again.
 */
export function SignInForm({ nextPath }: { nextPath: string }) {
  const [emailState, submitEmail, sendingEmail] = useActionState(requestSignInEmailAction, null);
  const [codeState, submitCode, verifyingCode] = useActionState(verifySignInCodeAction, null);
  const [email, setEmail] = useState('');

  const sentTo = emailState?.ok === true ? emailState.data.email : null;

  if (sentTo !== null) {
    return (
      <div className="flex flex-col gap-5">
        <div className="surface-card p-4">
          <h2 className="text-base font-semibold">Check your email</h2>
          <p className="mt-1 text-sm text-muted">
            We sent a sign-in link and a one-time code to <strong>{sentTo}</strong>. Open the link
            on this device, or enter the code below.
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
              // Looser tracking than before: at 0.4em a ten-digit code
              // overflowed the field on a narrow iPhone. No placeholder,
              // because any fixed-length example would be wrong for somebody.
              className={`${inputClassName} tracking-[0.25em]`}
            />
          </Field>
          <SubmitButton pending={verifyingCode}>Sign in</SubmitButton>
        </form>
      </div>
    );
  }

  return (
    <form action={submitEmail} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={nextPath} />
      <FormError message={emailState?.ok === false ? emailState.fieldErrors['form'] : undefined} />
      <Field
        label="Email address"
        htmlFor="email"
        hint="We will email you a sign-in link and a one-time code. No password needed."
        error={emailState?.ok === false ? emailState.fieldErrors['email'] : undefined}
      >
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={inputClassName}
          placeholder="you@example.com"
        />
      </Field>
      <SubmitButton pending={sendingEmail}>Email me a sign-in link</SubmitButton>
    </form>
  );
}

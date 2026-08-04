'use client';

import { useActionState, useState } from 'react';
import { Field, FormError, inputClassName, SubmitButton } from '@/components/ui/field';
import { requestSignInEmailAction, verifySignInCodeAction } from '@/server/actions/auth';

/**
 * Email-only sign-in. The same email carries a magic link and a 6-digit code,
 * so a player who opens their mail on a different device is not stuck.
 */
export function SignInForm() {
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
            We sent a sign-in link and a 6-digit code to <strong>{sentTo}</strong>. Open the link on
            this device, or enter the code below.
          </p>
        </div>

        <form action={submitCode} className="flex flex-col gap-4">
          <input type="hidden" name="email" value={sentTo} />
          <FormError
            message={codeState?.ok === false ? codeState.fieldErrors['form'] : undefined}
          />
          <Field
            label="6-digit code"
            htmlFor="token"
            error={codeState?.ok === false ? codeState.fieldErrors['token'] : undefined}
          >
            <input
              id="token"
              name="token"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              className={`${inputClassName} tracking-[0.4em]`}
              placeholder="000000"
            />
          </Field>
          <SubmitButton pending={verifyingCode}>Sign in</SubmitButton>
        </form>
      </div>
    );
  }

  return (
    <form action={submitEmail} className="flex flex-col gap-4">
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

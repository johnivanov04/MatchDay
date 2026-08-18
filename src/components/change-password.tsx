'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormError, SubmitButton } from '@/components/ui/field';
import { PasswordField } from '@/components/ui/password-field';
import { PASSWORD_REQUIREMENT_TEXT } from '@/lib/validation/password';
import { changePasswordAction } from '@/server/actions/auth-password';

/**
 * Changing a password from inside the app.
 *
 * ── THE PROBLEM THIS UI HAS TO SOLVE ───────────────────────────────────────
 *
 * MatchDay cannot tell whether the person reading this screen has a password.
 * Finding out would mean reading `auth.users.encrypted_password`, which needs
 * the service role — a privileged oracle built for a cosmetic decision, and
 * exactly the thing not to add. So the screen is designed for not knowing.
 *
 * It offers the ordinary change form, which asks for the current password
 * because somebody with a live session and a stolen laptop should not be able
 * to lock the owner out. If there is no current password to give, the form says
 * so in its error and points at the email route, which works for everybody and
 * proves the same thing a password would.
 *
 * That is why the "Set one by email" link is not an error state or a fallback
 * hidden behind a failure — it sits under the form, permanently, as an equal
 * option. For every member who joined MatchDay before passwords existed, it is
 * the only one that works, and they should not have to fail first to find it.
 */
export function ChangePassword() {
  const [state, submit, pending] = useActionState(changePasswordAction, null);
  const [open, setOpen] = useState(false);

  const fieldError = (field: string): string | undefined =>
    state?.ok === false ? state.fieldErrors[field] : undefined;

  if (!open) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-semibold">Password</p>
          <p className="text-xs text-muted">
            Used to sign in. If you have never set one, you can create it here too.
          </p>
        </div>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Set or change password
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-semibold">Set or change password</p>
        <p className="text-xs text-muted">
          You will stay signed in on this device. Other devices keep their sessions until they
          expire.
        </p>
      </div>

      {state?.ok === true ? (
        <p
          role="status"
          className="rounded-[var(--radius-md)] border border-pitch-500/40 bg-pitch-50 px-3 py-2 text-sm text-pitch-900 dark:bg-pitch-900/40 dark:text-pitch-50"
        >
          Password updated. Use it next time you sign in.
        </p>
      ) : null}

      <form action={submit} className="flex flex-col gap-4">
        <FormError message={fieldError('form')} />

        <PasswordField
          label="Current password"
          name="current_password"
          autoComplete="current-password"
          error={fieldError('current_password')}
        />

        <PasswordField
          label="New password"
          name="password"
          autoComplete="new-password"
          hint={PASSWORD_REQUIREMENT_TEXT}
          error={fieldError('password')}
        />

        <PasswordField
          label="Confirm new password"
          name="confirm_password"
          autoComplete="new-password"
          error={fieldError('confirm_password')}
        />

        <SubmitButton pending={pending}>Change password</SubmitButton>
      </form>

      {/* Permanent, not a fallback. See the note at the top of this file. */}
      <p className="text-sm text-muted">
        Never set a password, or cannot remember it?{' '}
        <Link href="/forgot-password" className="font-semibold underline underline-offset-4">
          Set one by email instead
        </Link>
        .
      </p>
    </div>
  );
}

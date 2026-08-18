'use client';

import { useActionState } from 'react';
import { FormError, SubmitButton } from '@/components/ui/field';
import { PasswordField } from '@/components/ui/password-field';
import { PASSWORD_REQUIREMENT_TEXT } from '@/lib/validation/password';
import { setPasswordAction } from '@/server/actions/auth-password';

/**
 * Choosing a new password from a recovery session.
 *
 * No current-password field, and that is the point: this screen is reached only
 * by proving control of the email address, which is the same proof a password
 * would give. Asking for the old one here would exclude exactly the people this
 * flow exists for — historical passwordless accounts, which have none.
 */
export function ResetPasswordForm({ nextPath }: { nextPath: string }) {
  const [state, submit, pending] = useActionState(setPasswordAction, null);

  const fieldError = (field: string): string | undefined =>
    state?.ok === false ? state.fieldErrors[field] : undefined;

  return (
    <form action={submit} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={nextPath} />
      <FormError message={fieldError('form')} />

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

      <SubmitButton pending={pending}>Set password</SubmitButton>
    </form>
  );
}

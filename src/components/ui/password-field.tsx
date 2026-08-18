'use client';

import { useId, useState } from 'react';
import { Field, inputClassName } from '@/components/ui/field';

/**
 * A password input with a show/hide control.
 *
 * ── WHY SHOW/HIDE IS NOT OPTIONAL ──────────────────────────────────────────
 *
 * MatchDay is typed on a phone, one-handed, often outdoors. A masked field with
 * no way to check what was typed is where long passwords go to be abandoned,
 * and "must be at least 10 characters" makes that worse rather than better. The
 * toggle is the thing that lets somebody use a passphrase.
 *
 * It is a `<button type="button">` inside the field. Not a checkbox, and not a
 * `<label>` — either would end up in the tab order between the password and the
 * submit, which is exactly where a password manager wants to be.
 *
 * ── AUTOCOMPLETE IS LOAD-BEARING ───────────────────────────────────────────
 *
 * `current-password` on a sign-in field and `new-password` on a signup or reset
 * field is what makes a password manager offer to fill one and to generate the
 * other. Getting it wrong means managers offer the old password on the "new
 * password" field, which people then accept.
 */
export function PasswordField({
  label,
  name,
  autoComplete,
  error,
  hint,
  required = true,
  defaultValue,
}: {
  label: string;
  name: string;
  autoComplete: 'current-password' | 'new-password';
  error?: string | undefined;
  hint?: string;
  required?: boolean;
  defaultValue?: string;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);

  return (
    <Field label={label} htmlFor={id} error={error} {...(hint === undefined ? {} : { hint })}>
      <div className="relative">
        <input
          id={id}
          name={name}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          required={required}
          // No `maxLength`: a password manager's generated secret can be long,
          // and silently truncating one produces a password nobody can ever
          // type again. The server bounds it.
          defaultValue={defaultValue}
          // `pr-[3.75rem]` keeps the text clear of the toggle, which is
          // absolutely positioned so the two cannot overlap at any width.
          className={`${inputClassName} pr-[3.75rem]`}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          // The state, not the action: a screen reader user needs to know
          // whether their password is currently exposed, which is the fact
          // `aria-pressed` carries.
          aria-pressed={visible}
          aria-label={visible ? 'Hide password' : 'Show password'}
          className="press absolute inset-y-0 right-0 flex min-h-control min-w-[3.25rem] items-center justify-center rounded-r-[var(--radius-md)] px-3 text-xs font-semibold text-secondary hover:text-[var(--text-primary)]"
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
    </Field>
  );
}

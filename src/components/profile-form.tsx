'use client';

import { useActionState } from 'react';
import { Field, FormError, inputClassName, SubmitButton } from '@/components/ui/field';
import { saveProfileAction } from '@/server/actions/profile';
import type { ProfileRow } from '@/types/database';

/**
 * Global profile form.
 *
 * First and last name are required; everything else is optional and may be left
 * blank forever (PRD §6). There is no skill-level or rating input, by product
 * decision — a league that needs positions or goalkeeper willingness will be
 * able to require them per league in a later phase, without changing what the
 * global account asks for.
 */
export function ProfileForm({
  profile,
  email,
  submitLabel,
}: {
  profile: ProfileRow | null;
  email: string;
  submitLabel: string;
}) {
  const [state, submit, pending] = useActionState(saveProfileAction, null);
  const fieldError = (name: string): string | undefined =>
    state?.ok === false ? state.fieldErrors[name] : undefined;

  const goalkeeperValue =
    profile?.goalkeeper_willing === true ? 'yes' : profile?.goalkeeper_willing === false ? 'no' : '';

  return (
    <form action={submit} className="flex flex-col gap-5">
      <FormError message={fieldError('form')} />
      {state?.ok === true ? (
        <p
          role="status"
          className="rounded-lg border border-pitch-500/40 bg-pitch-50 px-3 py-2 text-sm text-pitch-900 dark:bg-pitch-900/40 dark:text-pitch-50"
        >
          Profile saved.
        </p>
      ) : null}

      <fieldset className="flex flex-col gap-4">
        <legend className="sr-only">Required details</legend>

        <Field label="First name" htmlFor="first_name" error={fieldError('first_name')}>
          <input
            id="first_name"
            name="first_name"
            required
            maxLength={80}
            autoComplete="given-name"
            defaultValue={profile?.first_name ?? ''}
            className={inputClassName}
          />
        </Field>

        <Field label="Last name" htmlFor="last_name" error={fieldError('last_name')}>
          <input
            id="last_name"
            name="last_name"
            required
            maxLength={80}
            autoComplete="family-name"
            defaultValue={profile?.last_name ?? ''}
            className={inputClassName}
          />
        </Field>

        <Field label="Email" htmlFor="email" hint="Set by how you sign in and cannot be edited here.">
          <input
            id="email"
            name="email_display"
            type="email"
            value={email}
            readOnly
            disabled
            className={`${inputClassName} opacity-70`}
          />
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-sm font-semibold">Optional details</legend>
        <p className="-mt-2 text-xs text-muted">
          Only your league administrator can see these. They are never shown publicly.
        </p>

        <Field label="Phone number" htmlFor="phone" optional error={fieldError('phone')}>
          <input
            id="phone"
            name="phone"
            type="tel"
            maxLength={32}
            autoComplete="tel"
            defaultValue={profile?.phone ?? ''}
            className={inputClassName}
          />
        </Field>

        <Field label="Gender" htmlFor="gender" optional error={fieldError('gender')}>
          <input
            id="gender"
            name="gender"
            maxLength={64}
            defaultValue={profile?.gender ?? ''}
            className={inputClassName}
          />
        </Field>

        <Field
          label="Preferred positions"
          htmlFor="preferred_positions"
          optional
          hint="Separate with commas, for example: Midfield, Winger."
          error={fieldError('preferred_positions')}
        >
          <input
            id="preferred_positions"
            name="preferred_positions"
            defaultValue={(profile?.preferred_positions ?? []).join(', ')}
            className={inputClassName}
          />
        </Field>

        <Field
          label="Willing to play in goal"
          htmlFor="goalkeeper_willing"
          optional
          error={fieldError('goalkeeper_willing')}
        >
          <select
            id="goalkeeper_willing"
            name="goalkeeper_willing"
            defaultValue={goalkeeperValue}
            className={inputClassName}
          >
            <option value="">Prefer not to say</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>

        <Field
          label="Profile photo URL"
          htmlFor="profile_photo_url"
          optional
          hint="A full https:// address. Uploading a photo arrives in a later phase."
          error={fieldError('profile_photo_url')}
        >
          <input
            id="profile_photo_url"
            name="profile_photo_url"
            type="url"
            inputMode="url"
            defaultValue={profile?.profile_photo_url ?? ''}
            className={inputClassName}
          />
        </Field>
      </fieldset>

      <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
    </form>
  );
}

'use client';

import { useActionState, useState } from 'react';
import { Field, FormError, inputClassName, SubmitButton } from '@/components/ui/field';
import { slugifyLeagueName } from '@/lib/validation/league';
import { createLeagueAction, updateLeagueSettingsAction } from '@/server/actions/leagues';
import type { LeagueRow } from '@/types/database';

/**
 * Shared league form.
 *
 * `create` mode collects a slug; `settings` mode does not. The slug is the
 * league's stable address, and the update schema deliberately omits it so an
 * edit cannot silently break links people already hold.
 *
 * Visibility is absent from both modes. New leagues are private by product
 * decision, and switching to searchable is its own confirmed, separately
 * audited action.
 */
export function LeagueForm({
  mode,
  league,
  timezones,
}: {
  mode: 'create' | 'settings';
  league?: LeagueRow;
  timezones: string[];
}) {
  const [state, submit, pending] = useActionState(
    mode === 'create' ? createLeagueAction : updateLeagueSettingsAction,
    null,
  );
  const [name, setName] = useState(league?.name ?? '');
  const [slug, setSlug] = useState(league?.slug ?? '');
  const [slugEdited, setSlugEdited] = useState(mode === 'settings');

  const fieldError = (field: string): string | undefined =>
    state?.ok === false ? state.fieldErrors[field] : undefined;

  return (
    <form action={submit} className="flex flex-col gap-5">
      {league === undefined ? null : <input type="hidden" name="league_id" value={league.id} />}

      <FormError message={state?.ok === false ? state.message : undefined} />
      {state?.ok === true ? (
        <p
          role="status"
          className="rounded-lg border border-pitch-500/40 bg-pitch-50 px-3 py-2 text-sm text-pitch-900 dark:bg-pitch-900/40 dark:text-pitch-50"
        >
          League settings saved.
        </p>
      ) : null}

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-sm font-semibold">Identity</legend>

        <Field label="League name" htmlFor="name" error={fieldError('name')}>
          <input
            id="name"
            name="name"
            required
            maxLength={120}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (!slugEdited) setSlug(slugifyLeagueName(event.target.value));
            }}
            className={inputClassName}
            placeholder="Sunday Futsal"
          />
        </Field>

        {mode === 'create' ? (
          <Field
            label="League address"
            htmlFor="slug"
            hint="Used in links. Lowercase letters, numbers and hyphens."
            error={fieldError('slug')}
          >
            <input
              id="slug"
              name="slug"
              required
              maxLength={60}
              value={slug}
              onChange={(event) => {
                setSlugEdited(true);
                setSlug(event.target.value);
              }}
              className={inputClassName}
              placeholder="sunday-futsal"
            />
          </Field>
        ) : null}

        <Field
          label="Short description"
          htmlFor="description"
          hint="Shown in search results if this league is searchable."
          error={fieldError('description')}
        >
          <textarea
            id="description"
            name="description"
            required
            maxLength={280}
            rows={2}
            defaultValue={league?.description ?? ''}
            className={inputClassName}
          />
        </Field>

        <Field
          label="General area"
          htmlFor="general_area"
          hint="A neighbourhood or city — never an exact address."
          error={fieldError('general_area')}
        >
          <input
            id="general_area"
            name="general_area"
            required
            maxLength={120}
            defaultValue={league?.general_area ?? ''}
            className={inputClassName}
          />
        </Field>

        <Field label="Sport or format" htmlFor="sport_label" error={fieldError('sport_label')}>
          <input
            id="sport_label"
            name="sport_label"
            required
            maxLength={60}
            defaultValue={league?.sport_label ?? ''}
            className={inputClassName}
            placeholder="Soccer 5v5"
          />
        </Field>

        <Field label="Timezone" htmlFor="timezone" error={fieldError('timezone')}>
          {/* Uncontrolled: the browser's own zone cannot be read during render
              without diverging from the server's markup, so the list is simply
              presented and the database validates whatever is chosen. */}
          <select
            id="timezone"
            name="timezone"
            required
            defaultValue={league?.timezone ?? 'UTC'}
            className={inputClassName}
          >
            {timezones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-sm font-semibold">Match defaults</legend>
        <p className="-mt-2 text-xs text-muted">
          Starting points for each match. Individual matches can override them later.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Capacity"
            htmlFor="default_capacity"
            error={fieldError('default_capacity')}
          >
            <input
              id="default_capacity"
              name="default_capacity"
              type="number"
              inputMode="numeric"
              min={2}
              max={200}
              required
              defaultValue={league?.default_capacity ?? 10}
              className={inputClassName}
            />
          </Field>

          <Field
            label="Minimum players"
            htmlFor="default_min_players"
            error={fieldError('default_min_players')}
          >
            <input
              id="default_min_players"
              name="default_min_players"
              type="number"
              inputMode="numeric"
              min={0}
              max={200}
              required
              defaultValue={league?.default_min_players ?? 0}
              className={inputClassName}
            />
          </Field>
        </div>

        <Field label="Teams per match" htmlFor="default_team_count" error={fieldError('default_team_count')}>
          <input
            id="default_team_count"
            name="default_team_count"
            type="number"
            inputMode="numeric"
            min={2}
            max={20}
            required
            defaultValue={league?.default_team_count ?? 2}
            className={inputClassName}
          />
        </Field>

        <Field label="How spots are filled" htmlFor="default_selection_mode">
          <select
            id="default_selection_mode"
            name="default_selection_mode"
            defaultValue={league?.default_selection_mode ?? 'first_come'}
            className={inputClassName}
          >
            <option value="first_come">First come — confirmed immediately</option>
            <option value="admin_approval">Administrator chooses the roster</option>
          </select>
        </Field>

        <Field label="How the waitlist moves" htmlFor="default_waitlist_mode">
          <select
            id="default_waitlist_mode"
            name="default_waitlist_mode"
            defaultValue={league?.default_waitlist_mode ?? 'automatic'}
            className={inputClassName}
          >
            <option value="automatic">Automatically promote the next player</option>
            <option value="admin_controlled">Administrator promotes manually</option>
          </select>
        </Field>

        <Field
          label="Usual location"
          htmlFor="default_location"
          optional
          hint="Members only. Never included in public search results."
        >
          <input
            id="default_location"
            name="default_location"
            maxLength={160}
            defaultValue={league?.default_location ?? ''}
            className={inputClassName}
          />
        </Field>

        <Field
          label="Typical schedule"
          htmlFor="typical_schedule"
          optional
          hint="Shown publicly if this league is searchable."
        >
          <input
            id="typical_schedule"
            name="typical_schedule"
            maxLength={160}
            defaultValue={league?.typical_schedule ?? ''}
            className={inputClassName}
            placeholder="Thursdays, evenings"
          />
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold">Profile fields</legend>
        <p className="-mt-2 text-xs text-muted">
          Ask members for these when they join. Visible only to you.
        </p>

        <label className="flex items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            name="gender_field_enabled"
            defaultChecked={league?.gender_field_enabled ?? false}
            className="size-4"
          />
          Collect gender
        </label>

        <label className="flex items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            name="goalkeeper_field_enabled"
            defaultChecked={league?.goalkeeper_field_enabled ?? false}
            className="size-4"
          />
          Ask who is willing to play in goal
        </label>
      </fieldset>

      <SubmitButton pending={pending}>
        {mode === 'create' ? 'Create league' : 'Save settings'}
      </SubmitButton>

      {mode === 'create' ? (
        <p className="text-xs text-muted">
          Your league starts private. You can make it searchable from its settings once you are
          ready.
        </p>
      ) : null}
    </form>
  );
}

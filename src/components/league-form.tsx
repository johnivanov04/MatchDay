'use client';

import type { ReactNode } from 'react';
import { useActionState, useState } from 'react';
import {
  Field,
  FieldGroup,
  FormError,
  inputClassName,
  StepChip,
  SubmitButton,
} from '@/components/ui/field';
import { pluralize } from '@/lib/format/plural';
import { intervalToHoursField, slugifyLeagueName } from '@/lib/validation/league';
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
 *
 * ── WHY CREATE AND SETTINGS LOOK DIFFERENT ─────────────────────────────────
 *
 * Same fields, same action shapes, two different jobs. Creating a league is
 * somebody's first act in the product and they have no idea what a "waitlist
 * mode" is yet, so `create` renders as four numbered steps — three groups of
 * inputs and a review — inside cards. Settings is a person changing one thing
 * they already understand, so it stays a flat list where the field they came
 * for is one scroll away rather than three steps in.
 *
 * ── WHY IT IS NOT A WIZARD ─────────────────────────────────────────────────
 *
 * Every field stays mounted on one page. A stepper that unmounts steps has to
 * re-implement value retention, validation ordering and focus management, and
 * it hides the field somebody wants to fix behind a Back button. Numbering the
 * sequence gets the guidance; keeping it on one page keeps the browser's own
 * `required` handling, autofill, and "find on page" working.
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

  // Controlled only because the review step reads them back. Everything the
  // review does not mention stays uncontrolled — there is no reason to make
  // React re-render a fifteen-field form on every keystroke in a field nobody
  // is going to see again two inches lower.
  const [sportLabel, setSportLabel] = useState(league?.sport_label ?? '');
  const [generalArea, setGeneralArea] = useState(league?.general_area ?? '');
  const [capacity, setCapacity] = useState(String(league?.default_capacity ?? 10));
  const [teamCount, setTeamCount] = useState(String(league?.default_team_count ?? 2));

  const guided = mode === 'create';

  // The starting values a brand-new league sees, matching the column defaults
  // in `20260821120000_league_match_defaults.sql`.
  //
  // Chosen by mode rather than with `|| '2'` on the parsed value: zero is a
  // legitimate setting — "signup closes at kickoff" — and `'0' || '2'` is
  // `'2'`, so a league that had deliberately set zero would silently render as
  // two and be saved back that way the next time anybody touched the form.
  const timingField = (stored: string | null | undefined, whenCreating: string): string =>
    mode === 'create' ? whenCreating : intervalToHoursField(stored ?? null);

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

      <Group
        guided={guided}
        step={1}
        legend="League details"
        description="What this league is called and where it plays."
      >
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
            value={generalArea}
            onChange={(event) => setGeneralArea(event.target.value)}
            className={inputClassName}
          />
        </Field>

        <Field label="Sport or format" htmlFor="sport_label" error={fieldError('sport_label')}>
          <input
            id="sport_label"
            name="sport_label"
            required
            maxLength={60}
            value={sportLabel}
            onChange={(event) => setSportLabel(event.target.value)}
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
      </Group>

      <Group
        guided={guided}
        step={2}
        legend="Match setup"
        description="Starting points for each match. Individual matches can override them later."
      >
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
              value={capacity}
              onChange={(event) => setCapacity(event.target.value)}
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
            value={teamCount}
            onChange={(event) => setTeamCount(event.target.value)}
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
      </Group>

      {/*
        A group of its own rather than four more fields inside Match setup.

        Match setup is already eight controls; adding four numbers with the
        same unit turned it into a wall on a phone. These four also answer a
        different question — *when* things happen rather than *how many* people
        — and they are the ones that need the "this does not change existing
        matches" caveat, which needs somewhere to live.
      */}
      <Group
        guided={guided}
        step={3}
        legend="Match timing"
        description="Starting values for new matches, in hours before kickoff."
      >
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Signup closes"
            htmlFor="default_signup_closes_before"
            error={fieldError('default_signup_closes_before')}
          >
            <input
              id="default_signup_closes_before"
              name="default_signup_closes_before"
              type="number"
              inputMode="numeric"
              min={0}
              max={720}
              required
              defaultValue={timingField(league?.default_signup_closes_before, '2')}
              className={inputClassName}
            />
          </Field>

          <Field
            label="Cancellation cutoff"
            htmlFor="default_cancellation_cutoff_before"
            error={fieldError('default_cancellation_cutoff_before')}
          >
            <input
              id="default_cancellation_cutoff_before"
              name="default_cancellation_cutoff_before"
              type="number"
              inputMode="numeric"
              min={0}
              max={720}
              required
              defaultValue={timingField(league?.default_cancellation_cutoff_before, '24')}
              className={inputClassName}
            />
          </Field>
        </div>

        <Field
          label="Priority window"
          htmlFor="default_priority_window"
          optional
          hint="How long returning members get first refusal after a match opens. Leave blank for none."
          error={fieldError('default_priority_window')}
        >
          <input
            id="default_priority_window"
            name="default_priority_window"
            type="number"
            inputMode="numeric"
            min={0}
            max={720}
            defaultValue={timingField(league?.default_priority_window, '')}
            className={inputClassName}
          />
        </Field>

        <Field
          label="Roster publish target"
          htmlFor="default_roster_publish_before"
          optional
          // Says plainly that nothing happens on its own. A field sitting
          // beside two enforced deadlines reads as a third enforced deadline
          // unless it says otherwise, and this one is a note to self.
          hint="A planning target. MatchDay does not automatically publish the roster at this time."
          error={fieldError('default_roster_publish_before')}
        >
          <input
            id="default_roster_publish_before"
            name="default_roster_publish_before"
            type="number"
            inputMode="numeric"
            min={0}
            max={720}
            defaultValue={timingField(league?.default_roster_publish_before, '')}
            className={inputClassName}
          />
        </Field>

        <p className="text-xs text-muted">
          {guided
            ? 'These are the defaults for new matches. You can change them on an individual match later.'
            : 'These are the starting values for new matches, and can be changed on an individual match. Changing them here does not change matches that have already been created.'}
        </p>
      </Group>

      <Group
        guided={guided}
        step={4}
        legend="Player preferences"
        description="Ask members for these when they join. Visible only to you."
      >
        <label className="flex min-h-control cursor-pointer items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            name="gender_field_enabled"
            defaultChecked={league?.gender_field_enabled ?? false}
            className="size-5 shrink-0 accent-pitch-600"
          />
          Collect gender
        </label>

        <label className="flex min-h-control cursor-pointer items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            name="goalkeeper_field_enabled"
            defaultChecked={league?.goalkeeper_field_enabled ?? false}
            className="size-5 shrink-0 accent-pitch-600"
          />
          Ask who is willing to play in goal
        </label>
      </Group>

      {guided ? (
        <div className="surface-card flex flex-col gap-4 p-4">
          <div className="flex items-start gap-3">
            <StepChip step={5} />
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 className="text-[0.9375rem] font-semibold">Review</h2>
              <p className="text-sm text-muted">
                Everything here can be changed later from the league&rsquo;s settings.
              </p>
            </div>
          </div>

          {/* Reads back what was typed rather than repeating the labels above.
              The point of a review step is the sentence "this is the league you
              are about to make" — a second copy of the form would not be one. */}
          <dl className="flex flex-col gap-2.5 border-t border-[var(--border-subtle)] pt-4 text-sm">
            <SummaryRow label="Name" value={name} />
            <SummaryRow label="Address" value={slug === '' ? '' : `/leagues/${slug}`} />
            <SummaryRow
              label="Format"
              value={[sportLabel, generalArea].filter((part) => part !== '').join(' · ')}
            />
            <SummaryRow label="Each match" value={matchSummary(capacity, teamCount)} />
          </dl>

          <SubmitButton pending={pending}>Create league</SubmitButton>

          <p className="text-xs text-muted">
            Your league starts private. You can make it searchable from its settings once you are
            ready.
          </p>
        </div>
      ) : (
        <SubmitButton pending={pending}>Save settings</SubmitButton>
      )}
    </form>
  );
}

/**
 * A group of fields, numbered on the create screen and plain in settings.
 *
 * One component rather than two branches at each call site: the fields inside
 * are identical in both modes and duplicating them is how the two screens
 * would drift apart.
 */
function Group({
  guided,
  step,
  legend,
  description,
  children,
}: {
  guided: boolean;
  step: number;
  legend: string;
  description: string;
  children: ReactNode;
}) {
  if (guided) {
    return (
      <FieldGroup legend={legend} description={description} step={step}>
        {children}
      </FieldGroup>
    );
  }

  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="mb-1 text-sm font-semibold">{legend}</legend>
      <p className="-mt-2 text-xs text-muted">{description}</p>
      {children}
    </fieldset>
  );
}

/** One line of the review list. Blank values say so rather than showing a gap. */
function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted">{label}</dt>
      {/* Wraps rather than truncates: at 320px "Up to 10 players, 2 teams"
          became "Up to 10 players, 2 tea…", and a review that hides what it is
          reviewing is not one. `break-words` keeps a long unbroken slug inside
          the card. */}
      <dd
        className={`min-w-0 break-words text-right font-medium ${value === '' ? 'text-muted' : ''}`}
      >
        {value === '' ? 'Not set yet' : value}
      </dd>
    </div>
  );
}

/**
 * "Up to 10 players, 2 teams" — from the two number inputs, which are strings
 * and can be mid-edit or empty, so both are parsed defensively.
 */
function matchSummary(capacity: string, teamCount: string): string {
  const players = Number.parseInt(capacity, 10);
  const teams = Number.parseInt(teamCount, 10);
  const parts: string[] = [];

  if (Number.isFinite(players)) parts.push(`Up to ${pluralize(players, 'player')}`);
  if (Number.isFinite(teams)) parts.push(pluralize(teams, 'team'));

  return parts.join(', ');
}

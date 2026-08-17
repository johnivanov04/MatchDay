'use client';

import { useActionState } from 'react';
import {
  Field,
  FormError,
  inputClassName,
  SubmitButton,
  timeInputClassName,
} from '@/components/ui/field';
import {
  cancelMatchAction,
  publishMatchAction,
  saveMatchTemplateAction,
} from '@/server/actions/matches';
import type { MatchTemplateRow } from '@/types/database';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Turns a PostgreSQL interval string back into whole hours for a number input. */
function intervalToHours(interval: string | null): string {
  if (interval === null) return '';
  const hourMatch = /(\d+):(\d{2}):(\d{2})/.exec(interval);
  if (hourMatch !== null) {
    const hours = Number(hourMatch[1]) + Number(hourMatch[2]) / 60;
    return String(hours);
  }
  const dayMatch = /(\d+)\s+day/.exec(interval);
  if (dayMatch !== null) return String(Number(dayMatch[1]) * 24);
  return '';
}

export function MatchTemplateForm({
  leagueId,
  template,
}: {
  leagueId: string;
  template?: MatchTemplateRow;
}) {
  const [state, submit, pending] = useActionState(saveMatchTemplateAction, null);
  const fieldError = (name: string): string | undefined =>
    state?.ok === false ? state.fieldErrors[name] : undefined;

  return (
    <form action={submit} className="flex flex-col gap-4">
      <input type="hidden" name="league_id" value={leagueId} />
      {template === undefined ? null : (
        <input type="hidden" name="template_id" value={template.id} />
      )}

      <FormError message={state?.ok === false ? state.message : undefined} />
      {state?.ok === true ? (
        <p role="status" className="text-sm font-medium text-pitch-600">
          Template saved.
        </p>
      ) : null}

      <Field label="Template name" htmlFor="name" error={fieldError('name')}>
        <input
          id="name"
          name="name"
          required
          maxLength={120}
          defaultValue={template?.name ?? ''}
          className={inputClassName}
          placeholder="Monday evening 11v11"
        />
      </Field>

      <Field label="Usual day" htmlFor="day_of_week" optional>
        <select
          id="day_of_week"
          name="day_of_week"
          defaultValue={template?.day_of_week ?? ''}
          className={inputClassName}
        >
          <option value="">No fixed day</option>
          {DAY_NAMES.map((day, index) => (
            <option key={day} value={index}>
              {day}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-3 gap-2">
        <Field label="Arrive" htmlFor="arrival_time" error={fieldError('arrival_time')}>
          <input
            id="arrival_time"
            name="arrival_time"
            type="time"
            required
            defaultValue={template?.arrival_time?.slice(0, 5) ?? '18:30'}
            className={timeInputClassName}
          />
        </Field>
        <Field label="Kickoff" htmlFor="kickoff_time" error={fieldError('kickoff_time')}>
          <input
            id="kickoff_time"
            name="kickoff_time"
            type="time"
            required
            defaultValue={template?.kickoff_time?.slice(0, 5) ?? '19:00'}
            className={timeInputClassName}
          />
        </Field>
        <Field label="Ends" htmlFor="end_time" error={fieldError('end_time')}>
          <input
            id="end_time"
            name="end_time"
            type="time"
            required
            defaultValue={template?.end_time?.slice(0, 5) ?? '20:30'}
            className={timeInputClassName}
          />
        </Field>
      </div>

      <Field label="Location" htmlFor="location_name" error={fieldError('location_name')}>
        <input
          id="location_name"
          name="location_name"
          required
          maxLength={160}
          defaultValue={template?.location_name ?? ''}
          className={inputClassName}
        />
      </Field>

      <Field label="Map link" htmlFor="location_map_url" optional error={fieldError('location_map_url')}>
        <input
          id="location_map_url"
          name="location_map_url"
          type="url"
          defaultValue={template?.location_map_url ?? ''}
          className={inputClassName}
        />
      </Field>

      <div className="grid grid-cols-3 gap-2">
        <Field label="Capacity" htmlFor="capacity" error={fieldError('capacity')}>
          <input
            id="capacity"
            name="capacity"
            type="number"
            min={2}
            max={200}
            required
            defaultValue={template?.capacity ?? 10}
            className={inputClassName}
          />
        </Field>
        <Field label="Minimum" htmlFor="min_players" error={fieldError('min_players')}>
          <input
            id="min_players"
            name="min_players"
            type="number"
            min={0}
            max={200}
            required
            defaultValue={template?.min_players ?? 0}
            className={inputClassName}
          />
        </Field>
        <Field label="Teams" htmlFor="team_count" error={fieldError('team_count')}>
          <input
            id="team_count"
            name="team_count"
            type="number"
            min={2}
            max={20}
            required
            defaultValue={template?.team_count ?? 2}
            className={inputClassName}
          />
        </Field>
      </div>

      <Field label="How spots are filled" htmlFor="selection_mode">
        <select
          id="selection_mode"
          name="selection_mode"
          defaultValue={template?.selection_mode ?? 'first_come'}
          className={inputClassName}
        >
          <option value="first_come">First come — confirmed immediately</option>
          <option value="admin_approval">Administrator chooses the roster</option>
        </select>
      </Field>

      <Field label="How the waitlist moves" htmlFor="waitlist_mode">
        <select
          id="waitlist_mode"
          name="waitlist_mode"
          defaultValue={template?.waitlist_mode ?? 'automatic'}
          className={inputClassName}
        >
          <option value="automatic">Automatically promote the next player</option>
          <option value="admin_controlled">Administrator promotes manually</option>
        </select>
      </Field>

      <fieldset className="grid grid-cols-2 gap-3">
        <legend className="mb-1 text-sm font-semibold">Deadlines, in hours before kickoff</legend>
        <Field label="Signup closes" htmlFor="signup_closes_before_hours" error={fieldError('signup_closes_before_hours')}>
          <input
            id="signup_closes_before_hours"
            name="signup_closes_before_hours"
            type="number"
            min={0}
            max={720}
            required
            defaultValue={intervalToHours(template?.signup_closes_before ?? null) || '2'}
            className={inputClassName}
          />
        </Field>
        <Field label="Cancellation cutoff" htmlFor="cancellation_cutoff_before_hours" error={fieldError('cancellation_cutoff_before_hours')}>
          <input
            id="cancellation_cutoff_before_hours"
            name="cancellation_cutoff_before_hours"
            type="number"
            min={0}
            max={720}
            required
            defaultValue={intervalToHours(template?.cancellation_cutoff_before ?? null) || '24'}
            className={inputClassName}
          />
        </Field>
        <Field label="Priority window" htmlFor="priority_window_hours" optional>
          <input
            id="priority_window_hours"
            name="priority_window_hours"
            type="number"
            min={0}
            max={720}
            defaultValue={intervalToHours(template?.priority_window ?? null)}
            className={inputClassName}
          />
        </Field>
        <Field label="Roster published" htmlFor="roster_publish_before_hours" optional>
          <input
            id="roster_publish_before_hours"
            name="roster_publish_before_hours"
            type="number"
            min={0}
            max={720}
            defaultValue={intervalToHours(template?.roster_publish_before ?? null)}
            className={inputClassName}
          />
        </Field>
      </fieldset>

      <label className="flex min-h-control cursor-pointer items-center gap-2.5 text-sm">
        <input
          type="checkbox"
          name="is_active"
          defaultChecked={template?.is_active ?? true}
          className="size-5 shrink-0 accent-pitch-600"
        />
        Available when creating matches
      </label>

      <SubmitButton pending={pending}>
        {template === undefined ? 'Create template' : 'Save template'}
      </SubmitButton>
    </form>
  );
}

export function PublishMatchButton({
  leagueId,
  matchId,
}: {
  leagueId: string;
  matchId: string;
}) {
  const [state, submit, pending] = useActionState(publishMatchAction, null);

  return (
    <form action={submit} className="flex flex-col gap-2">
      <input type="hidden" name="league_id" value={leagueId} />
      <input type="hidden" name="match_id" value={matchId} />
      <button
        type="submit"
        disabled={pending}
        className="min-h-control rounded-lg bg-pitch-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-pitch-700 disabled:opacity-55"
      >
        {pending ? 'Publishing…' : 'Publish to members'}
      </button>
      <p className="text-xs text-muted">
        Publishing notifies every active member once. Publishing again changes nothing.
      </p>
      {state?.ok === false ? (
        <p role="alert" className="text-sm text-whistle-600 dark:text-whistle-300">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

export function CancelMatchForm({ leagueId, matchId }: { leagueId: string; matchId: string }) {
  const [state, submit, pending] = useActionState(cancelMatchAction, null);

  return (
    <form action={submit} className="flex flex-col gap-2">
      <input type="hidden" name="league_id" value={leagueId} />
      <input type="hidden" name="match_id" value={matchId} />
      <Field label="Reason" htmlFor="cancel-reason" optional hint="Shown to members in the audit trail.">
        <input id="cancel-reason" name="reason" maxLength={500} className={inputClassName} />
      </Field>
      <button
        type="submit"
        disabled={pending}
        className="min-h-control rounded-lg border border-whistle-300 px-4 py-2.5 text-sm font-semibold text-red-700 disabled:opacity-55 dark:text-red-300"
      >
        {pending ? 'Cancelling…' : 'Cancel this match'}
      </button>
      {state?.ok === false ? (
        <p role="alert" className="text-sm text-whistle-600 dark:text-whistle-300">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

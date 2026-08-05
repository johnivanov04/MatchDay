'use client';

import { useActionState, useState } from 'react';
import { Field, FormError, inputClassName, SubmitButton } from '@/components/ui/field';
import { createMatchAction } from '@/server/actions/matches';
import type { LeagueRow, MatchTemplateRow } from '@/types/database';

/**
 * Create-match form.
 *
 * Picking a template refills every field from it; league defaults fill the rest
 * when no template is chosen. Everything stays editable — a template is a
 * starting point, and 02 §9 requires all defaults be editable before
 * publication.
 *
 * Times are entered and submitted as local wall-clock values. The database
 * resolves them against the league's IANA zone, which is the only place that
 * conversion happens.
 */
export function CreateMatchForm({
  league,
  templates,
}: {
  league: LeagueRow;
  templates: MatchTemplateRow[];
}) {
  const [state, submit, pending] = useActionState(createMatchAction, null);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');

  const template = templates.find((candidate) => candidate.id === selectedTemplateId);
  const fieldError = (name: string): string | undefined =>
    state?.ok === false ? state.fieldErrors[name] : undefined;

  // `key` forces the uncontrolled inputs to remount with new defaults when the
  // template changes, which is what makes "picking a template refills the form"
  // work without turning every field into controlled state.
  const formKey = selectedTemplateId === '' ? 'blank' : selectedTemplateId;

  return (
    <form action={submit} className="flex flex-col gap-4">
      <input type="hidden" name="league_id" value={league.id} />
      <input type="hidden" name="league_slug" value={league.slug} />

      <FormError message={state?.ok === false ? state.message : undefined} />

      <Field label="Start from a template" htmlFor="template_id" optional>
        <select
          id="template_id"
          name="template_id"
          value={selectedTemplateId}
          onChange={(event) => setSelectedTemplateId(event.target.value)}
          className={inputClassName}
        >
          <option value="">No template — use league defaults</option>
          {templates
            .filter((candidate) => candidate.is_active)
            .map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
        </select>
      </Field>

      <div key={formKey} className="flex flex-col gap-4">
        <Field label="Match title" htmlFor="title" error={fieldError('title')}>
          <input
            id="title"
            name="title"
            required
            maxLength={160}
            defaultValue={template?.name ?? ''}
            className={inputClassName}
            placeholder="Monday night 11v11"
          />
        </Field>

        <Field label="Date" htmlFor="match_date" error={fieldError('match_date')}>
          <input
            id="match_date"
            name="match_date"
            type="date"
            required
            className={inputClassName}
          />
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Arrive" htmlFor="arrival_time" error={fieldError('arrival_time')}>
            <input
              id="arrival_time"
              name="arrival_time"
              type="time"
              required
              defaultValue={template?.arrival_time?.slice(0, 5) ?? '18:30'}
              className={inputClassName}
            />
          </Field>
          <Field label="Kickoff" htmlFor="kickoff_time" error={fieldError('kickoff_time')}>
            <input
              id="kickoff_time"
              name="kickoff_time"
              type="time"
              required
              defaultValue={template?.kickoff_time?.slice(0, 5) ?? '19:00'}
              className={inputClassName}
            />
          </Field>
          <Field label="Ends" htmlFor="end_time" error={fieldError('end_time')}>
            <input
              id="end_time"
              name="end_time"
              type="time"
              required
              defaultValue={template?.end_time?.slice(0, 5) ?? '20:30'}
              className={inputClassName}
            />
          </Field>
        </div>

        <p className="-mt-2 text-xs text-muted">
          Times are in {league.timezone}, the league&rsquo;s timezone.
        </p>

        <Field label="Location" htmlFor="location_name" error={fieldError('location_name')}>
          <input
            id="location_name"
            name="location_name"
            required
            maxLength={160}
            defaultValue={template?.location_name ?? league.default_location ?? ''}
            className={inputClassName}
          />
        </Field>

        <Field label="Map link" htmlFor="location_map_url" optional>
          <input
            id="location_map_url"
            name="location_map_url"
            type="url"
            defaultValue={template?.location_map_url ?? ''}
            className={inputClassName}
          />
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Capacity" htmlFor="capacity" error={fieldError('capacity')}>
            <input
              id="capacity"
              name="capacity"
              type="number"
              min={2}
              max={200}
              required
              defaultValue={template?.capacity ?? league.default_capacity}
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
              defaultValue={template?.min_players ?? league.default_min_players}
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
              defaultValue={template?.team_count ?? league.default_team_count}
              className={inputClassName}
            />
          </Field>
        </div>

        <Field label="How spots are filled" htmlFor="selection_mode">
          <select
            id="selection_mode"
            name="selection_mode"
            defaultValue={template?.selection_mode ?? league.default_selection_mode}
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
            defaultValue={template?.waitlist_mode ?? league.default_waitlist_mode}
            className={inputClassName}
          >
            <option value="automatic">Automatically promote the next player</option>
            <option value="admin_controlled">Administrator promotes manually</option>
          </select>
        </Field>

        <fieldset className="grid grid-cols-2 gap-3">
          <legend className="mb-1 text-sm font-semibold">Deadlines, hours before kickoff</legend>
          <Field label="Signup closes" htmlFor="signup_closes_before_hours">
            <input
              id="signup_closes_before_hours"
              name="signup_closes_before_hours"
              type="number"
              min={0}
              max={720}
              required
              defaultValue="2"
              className={inputClassName}
            />
          </Field>
          <Field label="Cancellation cutoff" htmlFor="cancellation_cutoff_before_hours">
            <input
              id="cancellation_cutoff_before_hours"
              name="cancellation_cutoff_before_hours"
              type="number"
              min={0}
              max={720}
              required
              defaultValue="24"
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
              className={inputClassName}
            />
          </Field>
        </fieldset>

        <Field label="Notes for members" htmlFor="public_notes" optional>
          <textarea
            id="public_notes"
            name="public_notes"
            rows={2}
            maxLength={2000}
            className={inputClassName}
          />
        </Field>

        <Field
          label="Private notes"
          htmlFor="admin_notes"
          optional
          hint="Only you can read these. They are stored separately from the match."
        >
          <textarea
            id="admin_notes"
            name="admin_notes"
            rows={2}
            maxLength={4000}
            className={inputClassName}
          />
        </Field>
      </div>

      <SubmitButton pending={pending}>Create as draft</SubmitButton>
      <p className="text-xs text-muted">
        The match is created as a draft. Members see nothing until you publish it.
      </p>
    </form>
  );
}

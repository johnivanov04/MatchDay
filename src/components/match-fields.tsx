'use client';

import { Field, inputClassName, timeInputClassName } from '@/components/ui/field';

/**
 * The match form fields, shared by creation and by both edit modes.
 *
 * Presentational only — no actions, no state, no fetching. Extracted so the
 * field list, its bounds and its help text exist once: three copies would drift,
 * and the copy most likely to drift is the one describing what members can see.
 *
 * Everything is uncontrolled with `defaultValue`, so the same component serves
 * an empty create form and a prefilled edit form without any branching.
 */

export interface MatchCoreDefaults {
  title: string;
  match_date: string;
  arrival_time: string;
  kickoff_time: string;
  end_time: string;
  location_name: string;
  location_map_url: string;
  capacity: number;
  min_players: number;
  team_count: number;
  public_notes: string;
}

export interface MatchPolicyDefaults {
  selection_mode: string;
  waitlist_mode: string;
  priority_window_hours: string;
  signup_closes_before_hours: string;
  cancellation_cutoff_before_hours: string;
  roster_publish_before_hours: string;
}

type FieldError = (name: string) => string | undefined;

/**
 * Title, date, times, place, size and public notes.
 *
 * These are the fields a published match may still change: they describe *this
 * occasion*, not the terms on which people agreed to play.
 */
export function MatchCoreFields({
  defaults,
  timezone,
  fieldError,
}: {
  defaults: MatchCoreDefaults;
  timezone: string;
  fieldError: FieldError;
}) {
  return (
    <>
      <Field label="Match title" htmlFor="title" error={fieldError('title')}>
        <input
          id="title"
          name="title"
          required
          maxLength={160}
          defaultValue={defaults.title}
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
          defaultValue={defaults.match_date}
          className={timeInputClassName}
        />
      </Field>

      <div className="grid grid-cols-3 gap-2">
        <Field label="Arrive" htmlFor="arrival_time" error={fieldError('arrival_time')}>
          <input
            id="arrival_time"
            name="arrival_time"
            type="time"
            required
            defaultValue={defaults.arrival_time}
            className={timeInputClassName}
          />
        </Field>
        <Field label="Kickoff" htmlFor="kickoff_time" error={fieldError('kickoff_time')}>
          <input
            id="kickoff_time"
            name="kickoff_time"
            type="time"
            required
            defaultValue={defaults.kickoff_time}
            className={timeInputClassName}
          />
        </Field>
        <Field label="Ends" htmlFor="end_time" error={fieldError('end_time')}>
          <input
            id="end_time"
            name="end_time"
            type="time"
            required
            defaultValue={defaults.end_time}
            className={timeInputClassName}
          />
        </Field>
      </div>

      {/* Named explicitly, because these are wall-clock times in the league's
          zone and not in the reader's. */}
      <p className="-mt-2 text-xs text-muted">Times are in {timezone}, the league&rsquo;s timezone.</p>

      <Field label="Location" htmlFor="location_name" error={fieldError('location_name')}>
        <input
          id="location_name"
          name="location_name"
          required
          maxLength={160}
          defaultValue={defaults.location_name}
          className={inputClassName}
        />
      </Field>

      <Field
        label="Map link"
        htmlFor="location_map_url"
        optional
        error={fieldError('location_map_url')}
      >
        <input
          id="location_map_url"
          name="location_map_url"
          type="url"
          defaultValue={defaults.location_map_url}
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
            defaultValue={defaults.capacity}
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
            defaultValue={defaults.min_players}
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
            defaultValue={defaults.team_count}
            className={inputClassName}
          />
        </Field>
      </div>

      <Field label="Notes for members" htmlFor="public_notes" optional>
        <textarea
          id="public_notes"
          name="public_notes"
          rows={2}
          maxLength={2000}
          defaultValue={defaults.public_notes}
          className={inputClassName}
        />
      </Field>
    </>
  );
}

/**
 * Selection mode, waitlist mode and the four deadline rules.
 *
 * Rendered for creation and for draft editing, and deliberately **not** for a
 * published match: these are the terms on which members responded, and changing
 * them after the fact would rewrite an agreement rather than update a detail.
 */
export function MatchPolicyFields({
  defaults,
  fieldError,
}: {
  defaults: MatchPolicyDefaults;
  fieldError: FieldError;
}) {
  return (
    <>
      <Field label="How spots are filled" htmlFor="selection_mode">
        <select
          id="selection_mode"
          name="selection_mode"
          defaultValue={defaults.selection_mode}
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
          defaultValue={defaults.waitlist_mode}
          className={inputClassName}
        >
          <option value="automatic">Automatically promote the next player</option>
          <option value="admin_controlled">Administrator promotes manually</option>
        </select>
      </Field>

      <fieldset className="grid grid-cols-2 gap-3">
        <legend className="mb-1 text-sm font-semibold">Deadlines, hours before kickoff</legend>
        <Field
          label="Signup closes"
          htmlFor="signup_closes_before_hours"
          error={fieldError('signup_closes_before_hours')}
        >
          <input
            id="signup_closes_before_hours"
            name="signup_closes_before_hours"
            type="number"
            min={0}
            max={720}
            required
            defaultValue={defaults.signup_closes_before_hours}
            className={inputClassName}
          />
        </Field>
        <Field
          label="Cancellation cutoff"
          htmlFor="cancellation_cutoff_before_hours"
          error={fieldError('cancellation_cutoff_before_hours')}
        >
          <input
            id="cancellation_cutoff_before_hours"
            name="cancellation_cutoff_before_hours"
            type="number"
            min={0}
            max={720}
            required
            defaultValue={defaults.cancellation_cutoff_before_hours}
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
            defaultValue={defaults.priority_window_hours}
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
            defaultValue={defaults.roster_publish_before_hours}
            className={inputClassName}
          />
        </Field>
      </fieldset>
    </>
  );
}

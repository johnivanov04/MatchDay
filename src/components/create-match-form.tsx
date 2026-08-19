'use client';

import { useActionState, useState } from 'react';
import {
  MatchCoreFields,
  MatchPolicyFields,
  type MatchCoreDefaults,
  type MatchPolicyDefaults,
} from '@/components/match-fields';
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
 *
 * The fields themselves come from the same components the edit forms use, so
 * the field list, its bounds and its help text exist once.
 */

/** PostgreSQL renders intervals as `HH:MM:SS`, or `N days ...` past a day. */
function intervalToHours(interval: string | null): string {
  if (interval === null) return '';
  const days = /(\d+)\s+day/.exec(interval);
  const clock = /(\d+):(\d{2}):(\d{2})/.exec(interval);
  const total =
    (days === null ? 0 : Number(days[1]) * 24) +
    (clock === null ? 0 : Number(clock[1]) + Number(clock[2]) / 60);
  return days === null && clock === null ? '' : String(Math.round(total));
}

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

  const core: MatchCoreDefaults = {
    title: template?.name ?? '',
    match_date: '',
    arrival_time: template?.arrival_time?.slice(0, 5) ?? '18:30',
    kickoff_time: template?.kickoff_time?.slice(0, 5) ?? '19:00',
    end_time: template?.end_time?.slice(0, 5) ?? '20:30',
    location_name: template?.location_name ?? league.default_location ?? '',
    location_map_url: template?.location_map_url ?? '',
    capacity: template?.capacity ?? league.default_capacity,
    min_players: template?.min_players ?? league.default_min_players,
    team_count: template?.team_count ?? league.default_team_count,
    public_notes: '',
  };

  // ── Where the timing values come from ──────────────────────────────────
  //
  //     selected template  →  league defaults
  //
  // Resolved at the *object* level, not field by field, and that distinction is
  // the whole point. A template that stores `priority_window = null` is saying
  // "this kind of match has no priority window" — a deliberate statement, not
  // an absence. A field-level `template?.priority_window ?? league.default…`
  // would silently replace that null with the league's value and quietly give
  // the match a window its template said it should not have.
  //
  // So the source is chosen once: if a template is selected it answers for all
  // four fields, including with nulls. There is no third tier — the league
  // columns are NOT NULL where a value is always needed, so the hard-coded
  // '2' and '24' that used to sit at the end of this chain are gone.
  const timing = template ?? {
    priority_window: league.default_priority_window,
    signup_closes_before: league.default_signup_closes_before,
    cancellation_cutoff_before: league.default_cancellation_cutoff_before,
    roster_publish_before: league.default_roster_publish_before,
  };

  const policy: MatchPolicyDefaults = {
    selection_mode: template?.selection_mode ?? league.default_selection_mode,
    waitlist_mode: template?.waitlist_mode ?? league.default_waitlist_mode,
    priority_window_hours: intervalToHours(timing.priority_window),
    signup_closes_before_hours: intervalToHours(timing.signup_closes_before),
    cancellation_cutoff_before_hours: intervalToHours(timing.cancellation_cutoff_before),
    roster_publish_before_hours: intervalToHours(timing.roster_publish_before),
  };

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
        <MatchCoreFields defaults={core} timezone={league.timezone} fieldError={fieldError} />
        <MatchPolicyFields defaults={policy} fieldError={fieldError} />

        {/* Where these numbers came from. Without it, an organizer who has set
            league defaults sees them appear here and cannot tell whether they
            are inherited or something this form invented — and editing them
            looks like it might change the league. It does not: anything typed
            here applies to this match alone. */}
        <p className="-mt-1 text-xs text-muted">
          {template === undefined
            ? 'Using your league defaults. Changes here apply to this match only.'
            : `Using defaults from ${template.name}. Changes here apply to this match only.`}
        </p>

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

      {/*
        Two outcomes, one form.

        Publishing is the primary action because it is what an organizer came
        here to do: the old form offered "Create as draft" and nothing else, so
        every match needed a second visit to open it — and the ones nobody
        remembered to open simply never happened. Draft stays, in secondary
        treatment, because a half-planned match with no location yet is a real
        thing to want.

        `name="intent"` on each button is what tells the action them apart; a
        submit button contributes its own name and value. No confirmation
        dialog: the hierarchy says which is which, and publishing a match is
        recoverable — it can be cancelled, and members are told.
      */}
      <div className="flex flex-col-reverse gap-2 sm:flex-row-reverse">
        <SubmitButton pending={pending} name="intent" value="publish" block={false} className="flex-1">
          Publish match
        </SubmitButton>
        <SubmitButton
          pending={pending}
          name="intent"
          value="draft"
          variant="secondary"
          block={false}
          className="flex-1"
        >
          Save as draft
        </SubmitButton>
      </div>
      <p className="text-xs text-muted">
        Publishing opens signup and notifies every active member once. A draft stays invisible
        until you publish it.
      </p>
    </form>
  );
}

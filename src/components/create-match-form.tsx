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

  const policy: MatchPolicyDefaults = {
    selection_mode: template?.selection_mode ?? league.default_selection_mode,
    waitlist_mode: template?.waitlist_mode ?? league.default_waitlist_mode,
    priority_window_hours: intervalToHours(template?.priority_window ?? null),
    signup_closes_before_hours: intervalToHours(template?.signup_closes_before ?? null) || '2',
    cancellation_cutoff_before_hours:
      intervalToHours(template?.cancellation_cutoff_before ?? null) || '24',
    roster_publish_before_hours: intervalToHours(template?.roster_publish_before ?? null),
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

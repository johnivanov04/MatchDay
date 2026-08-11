'use client';

import { useActionState } from 'react';
import {
  MatchCoreFields,
  MatchPolicyFields,
  type MatchCoreDefaults,
  type MatchPolicyDefaults,
} from '@/components/match-fields';
import { Field, FormError, inputClassName, SubmitButton } from '@/components/ui/field';
import {
  saveMatchAdminNotesAction,
  updateDraftMatchAction,
  updatePublishedMatchAction,
} from '@/server/actions/matches';

/**
 * Two edit forms rather than one with a mode flag.
 *
 * They differ in the fields they expose, the action they call, and whether
 * saving alerts anybody — which is nearly everything a form is. Branching all
 * of that inside one component would put the rule "participation terms are
 * frozen after publication" behind an `if`, where it is easy to lose. The field
 * markup they share lives in `MatchCoreFields` / `MatchPolicyFields`, so the
 * duplication here is genuinely only the parts that differ.
 */

interface CommonProps {
  leagueId: string;
  leagueSlug: string;
  matchId: string;
  timezone: string;
  core: MatchCoreDefaults;
}

/**
 * Draft editing: everything is fair game.
 *
 * Members have never seen this match, so there is no expectation to preserve
 * and nothing to announce. Saving notifies nobody.
 */
export function EditDraftMatchForm({
  leagueId,
  leagueSlug,
  matchId,
  timezone,
  core,
  policy,
}: CommonProps & { policy: MatchPolicyDefaults }) {
  const [state, submit, pending] = useActionState(updateDraftMatchAction, null);
  const fieldError = (name: string): string | undefined =>
    state?.ok === false ? state.fieldErrors[name] : undefined;

  return (
    <form action={submit} className="flex flex-col gap-4">
      <input type="hidden" name="league_id" value={leagueId} />
      <input type="hidden" name="league_slug" value={leagueSlug} />
      <input type="hidden" name="match_id" value={matchId} />

      <FormError message={state?.ok === false ? state.message : undefined} />

      <p className="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm text-muted">
        This match is a draft. Members cannot see it, and saving does not notify anybody.
      </p>

      <MatchCoreFields defaults={core} timezone={timezone} fieldError={fieldError} />
      <MatchPolicyFields defaults={policy} fieldError={fieldError} />

      <SubmitButton pending={pending}>Save draft</SubmitButton>
    </form>
  );
}

/**
 * Published editing: a narrower form, and a louder one.
 *
 * Selection mode, waitlist mode and the deadline rules are absent by design —
 * they are the terms members responded to. `expected_revision` carries the
 * revision this form was rendered from, so a save that lost a race is refused
 * rather than quietly overwriting somebody else's change and telling members
 * about a time that no longer applies.
 */
export function EditOpenMatchForm({
  leagueId,
  leagueSlug,
  matchId,
  timezone,
  core,
  revision,
}: CommonProps & { revision: number }) {
  const [state, submit, pending] = useActionState(updatePublishedMatchAction, null);
  const fieldError = (name: string): string | undefined =>
    state?.ok === false ? state.fieldErrors[name] : undefined;

  return (
    <form action={submit} className="flex flex-col gap-4">
      <input type="hidden" name="league_id" value={leagueId} />
      <input type="hidden" name="league_slug" value={leagueSlug} />
      <input type="hidden" name="match_id" value={matchId} />
      <input type="hidden" name="expected_revision" value={revision} />

      <FormError message={state?.ok === false ? state.message : undefined} />

      <p
        role="status"
        className="rounded-lg border border-pitch-500/50 bg-pitch-50 px-3 py-2 text-sm dark:bg-pitch-900/40"
      >
        <strong>This match is published.</strong> Saving changes notifies every active member of
        the league — in the app, and on their phone if they have alerts enabled.
      </p>

      <MatchCoreFields defaults={core} timezone={timezone} fieldError={fieldError} />

      <Field
        label="What changed"
        htmlFor="change_note"
        optional
        hint="Recorded in the audit log for other administrators. Not sent to members."
        error={fieldError('change_note')}
      >
        <input id="change_note" name="change_note" maxLength={500} className={inputClassName} />
      </Field>

      <p className="text-xs text-muted">
        Signup rules, waitlist behaviour and the deadlines are fixed once a match is published —
        they are the terms members responded to. Cancel and recreate the match if those need to
        change.
      </p>

      <SubmitButton pending={pending}>Save and notify members</SubmitButton>
    </form>
  );
}

/**
 * Administrator notes.
 *
 * A separate form with its own action, so that changing a private note does not
 * mean re-submitting the match — and, for a published match, does not mean
 * triggering a member notification.
 */
export function MatchAdminNotesForm({
  leagueId,
  leagueSlug,
  matchId,
  notes,
}: {
  leagueId: string;
  leagueSlug: string;
  matchId: string;
  notes: string;
}) {
  const [state, submit, pending] = useActionState(saveMatchAdminNotesAction, null);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="league_id" value={leagueId} />
      <input type="hidden" name="league_slug" value={leagueSlug} />
      <input type="hidden" name="match_id" value={matchId} />

      <FormError message={state?.ok === false ? state.message : undefined} />

      <Field
        label="Private notes"
        htmlFor="notes"
        optional
        hint="Only administrators of this league can read these. Members never see them, and they never appear in a notification."
        error={state?.ok === false ? state.fieldErrors['notes'] : undefined}
      >
        <textarea
          id="notes"
          name="notes"
          rows={4}
          maxLength={4000}
          defaultValue={notes}
          className={inputClassName}
        />
      </Field>

      <SubmitButton pending={pending} variant="secondary">
        Save notes
      </SubmitButton>
      <p className="text-xs text-muted">
        Clearing the box removes the note. Saving notes never notifies members.
      </p>
    </form>
  );
}

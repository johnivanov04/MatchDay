'use client';

import { useActionState } from 'react';
import { allowedOutcomes, ATTENDANCE_OUTCOME_LABELS } from '@/lib/matches/attendance-display';
import { FormError, inputClassName, SubmitButton } from '@/components/ui/field';
import { PlayerAvatar } from '@/components/ui/player-avatar';
import { completeMatchAction, recordAttendanceAction } from '@/server/actions/attendance';
import type { AttendanceOutcome, AttendanceWorkspaceEntry } from '@/types/database';

/**
 * The administrator's attendance register.
 *
 * Server-rendered data only. Every row is somebody the database decided was in
 * the attendance population — everybody who was ever confirmed, including those
 * who later withdrew — so this file never computes eligibility, and a player
 * who was never confirmed cannot appear here by any client-side path.
 *
 * NOTHING HERE DISCIPLINES ANYBODY. Recording a no-show sends the player the
 * canonical in-app notification and stops. There is no warning tier, no colour
 * scale, no counter that grows, and no control anywhere on this screen that
 * suspends or removes somebody. The one place a no-show count appears is the
 * roster workspace, as a fact next to a name, where the administrator is
 * choosing a roster and can act on it themselves — which is what 04 §1 settled.
 */

function fullName(entry: { first_name: string; last_name: string }): string {
  return `${entry.first_name} ${entry.last_name}`.trim();
}

function recordedLabel(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** True when this player left the match rather than being expected at it. */
function withdrew(entry: AttendanceWorkspaceEntry): boolean {
  return entry.signup_status === 'canceled' || entry.signup_status === 'withdrawn_late';
}

/**
 * How the player left, in the administrator's words.
 *
 * "Withdrew after the cutoff" rather than "late cancellation" or anything
 * stronger: Phase 5 classifies the withdrawal and Phase 7 does not re-judge it.
 * Whether it becomes a no-show is the administrator's decision, made with the
 * outcome buttons beside this text.
 */
function statusNote(entry: AttendanceWorkspaceEntry): string | null {
  switch (entry.signup_status) {
    case 'canceled':
      return 'Withdrew before the cutoff';
    case 'withdrawn_late':
      return 'Withdrew after the cutoff';
    case 'not_selected':
      return 'Removed from the match by an administrator';
    default:
      return null;
  }
}

/**
 * One player's row.
 *
 * The whole row is one form, so the outcome, the note and the revision the form
 * was rendered against are submitted together. Submitting them separately would
 * let a note land against an outcome somebody else had already changed.
 */
function AttendanceRow({
  entry,
  leagueId,
  matchId,
  disabled,
}: {
  entry: AttendanceWorkspaceEntry;
  leagueId: string;
  matchId: string;
  disabled: boolean;
}) {
  const [state, submit, pending] = useActionState(recordAttendanceAction, null);

  const note = statusNote(entry);
  const options = allowedOutcomes(withdrew(entry));
  // The suggestion is a default, never an answer: the administrator confirms it
  // by pressing Save like any other choice, and it is never `no_show`.
  const selected: AttendanceOutcome | '' = entry.outcome ?? entry.suggested ?? '';
  const noteFieldId = `note-${entry.membership_id}`;
  const outcomeFieldId = `outcome-${entry.membership_id}`;

  return (
    <li className="border-b border-[var(--border-subtle)] py-3 last:border-b-0">
      <form action={submit} className="flex flex-col gap-2">
        <input type="hidden" name="league_id" value={leagueId} />
        <input type="hidden" name="match_id" value={matchId} />
        <input type="hidden" name="membership_id" value={entry.membership_id} />
        {/* What this form was rendered against. A correction that arrives
            against a revision somebody else has already moved past is refused
            rather than overwriting a decision this administrator never saw. */}
        <input type="hidden" name="expected_revision" value={entry.revision ?? ''} />

        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          {/* `items-center` rather than `items-baseline`: a 32px circle has no
              text baseline to align to, and baseline alignment would hang it
              below the name. */}
          <span className="flex min-w-0 items-center gap-2.5">
            <PlayerAvatar player={entry} size={32} />
            <span className="min-w-0 truncate text-sm font-medium">{fullName(entry)}</span>
          </span>
          {entry.outcome === null ? (
            <p className="text-xs text-muted">Not recorded yet</p>
          ) : (
            <p className="text-xs text-muted">
              {ATTENDANCE_OUTCOME_LABELS[entry.outcome]}
              {entry.recorded_at === null ? '' : ` · ${recordedLabel(entry.recorded_at)}`}
              {entry.revision !== null && entry.revision > 1
                ? ` · corrected ${String(entry.revision - 1)}×`
                : ''}
            </p>
          )}
        </div>

        {note === null ? null : <p className="text-xs text-muted">{note}</p>}

        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1">
            <label htmlFor={outcomeFieldId} className="sr-only">
              Attendance for {fullName(entry)}
            </label>
            <select
              id={outcomeFieldId}
              name="outcome"
              defaultValue={selected}
              disabled={disabled || pending}
              required
              className={inputClassName}
            >
              <option value="" disabled>
                Choose an outcome
              </option>
              {options.map((outcome) => (
                <option key={outcome} value={outcome}>
                  {ATTENDANCE_OUTCOME_LABELS[outcome]}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-40 flex-1">
            <label htmlFor={noteFieldId} className="sr-only">
              Note about {fullName(entry)}, visible only to administrators
            </label>
            <input
              id={noteFieldId}
              name="note"
              type="text"
              defaultValue={entry.note ?? ''}
              maxLength={1000}
              disabled={disabled || pending}
              placeholder="Note (administrators only)"
              className={inputClassName}
            />
          </div>
          <SubmitButton pending={pending} variant="secondary">
            {entry.outcome === null ? 'Save' : 'Update'}
          </SubmitButton>
        </div>

        <FormError message={state?.ok === false ? state.message : undefined} />
      </form>
    </li>
  );
}

/** Closes the match, once everybody has an outcome. */
function CompleteMatch({
  leagueId,
  matchId,
  outstanding,
}: {
  leagueId: string;
  matchId: string;
  outstanding: number;
}) {
  const [state, submit, pending] = useActionState(completeMatchAction, null);

  return (
    <form action={submit} className="surface-card flex flex-col gap-2 p-4">
      <input type="hidden" name="league_id" value={leagueId} />
      <input type="hidden" name="match_id" value={matchId} />
      <p className="text-sm text-muted">
        {outstanding === 0
          ? 'Everybody has an outcome. Completing the match closes the register; you can still correct a record afterwards.'
          : `${String(outstanding)} ${outstanding === 1 ? 'player still needs' : 'players still need'} an outcome.`}
      </p>
      <FormError message={state?.ok === false ? state.message : undefined} />
      <div>
        <SubmitButton pending={pending}>Complete match</SubmitButton>
      </div>
    </form>
  );
}

export function AttendanceWorkspace({
  leagueId,
  matchId,
  entries,
  completed,
}: {
  leagueId: string;
  matchId: string;
  entries: AttendanceWorkspaceEntry[];
  completed: boolean;
}) {
  const outstanding = entries.filter((entry) => entry.outcome === null).length;

  if (entries.length === 0) {
    return (
      <section className="surface-card p-4">
        <p className="text-sm text-muted">
          Nobody was confirmed for this match, so there is no attendance to record.
        </p>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="surface-card p-4">
        <h2 className="text-sm font-semibold">
          Who was expected <span className="text-muted">({entries.length})</span>
        </h2>
        <p className="mt-1 text-xs text-muted">
          Everybody who was confirmed at any point, including anybody who withdrew. Notes are
          visible only to administrators and are never sent to the player.
        </p>
        <ul className="mt-2">
          {entries.map((entry) => (
            <AttendanceRow
              key={entry.membership_id}
              entry={entry}
              leagueId={leagueId}
              matchId={matchId}
              // A completed match stays correctable — corrections are the point
              // of the audit history — so nothing is disabled here. The flag
              // exists for a canceled match, where there is nothing to record.
              disabled={false}
            />
          ))}
        </ul>
      </section>

      {completed ? (
        <p role="status" className="text-sm text-muted">
          This match is complete. Corrections are still recorded, and the player is told each time.
        </p>
      ) : (
        <CompleteMatch leagueId={leagueId} matchId={matchId} outstanding={outstanding} />
      )}
    </div>
  );
}

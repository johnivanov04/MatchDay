'use client';

import { useActionState, useState } from 'react';
import { FormError, inputClassName, SubmitButton } from '@/components/ui/field';
import {
  addMemberToMatchAction,
  finalizeRosterAction,
  reorderWaitlistAction,
  setSignupDecisionAction,
} from '@/server/actions/signups';
import type { AddableMember, RosterAdminEntry, SignupStatus } from '@/types/database';

/**
 * The administrator's roster workspace.
 *
 * Server-rendered data only: every field on `RosterAdminEntry` is one the
 * database projection already decided this administrator may see. Gender and
 * goalkeeper willingness arrive as `null` unless the league enabled those
 * fields, so this file never has to know the league settings — it renders what
 * it is given.
 *
 * There is no attendance count and no no-show warning. 02 §11 lists both, but
 * Phase 7 owns attendance and no such data exists; showing a zero would be a
 * fabricated statistic an administrator might act on.
 */

function fullName(entry: { first_name: string; last_name: string }): string {
  return `${entry.first_name} ${entry.last_name}`.trim();
}

function respondedLabel(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** One decision button. Every administrator action is a form post, never a fetch. */
function DecisionButton({
  leagueId,
  matchId,
  membershipId,
  status,
  label,
}: {
  leagueId: string;
  matchId: string;
  membershipId: string;
  status: SignupStatus;
  label: string;
}) {
  const [state, submit, pending] = useActionState(setSignupDecisionAction, null);

  return (
    <form action={submit} className="inline">
      <input type="hidden" name="league_id" value={leagueId} />
      <input type="hidden" name="match_id" value={matchId} />
      <input type="hidden" name="membership_id" value={membershipId} />
      <input type="hidden" name="status" value={status} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-9 items-center rounded-lg border border-[var(--border-subtle)] px-2.5 py-1 text-xs font-semibold disabled:opacity-60"
        title={state?.ok === false ? state.message : undefined}
      >
        {pending ? '…' : label}
      </button>
    </form>
  );
}

function PlayerRow({
  entry,
  leagueId,
  matchId,
}: {
  entry: RosterAdminEntry;
  leagueId: string;
  matchId: string;
}) {
  const context = [
    entry.waitlist_position === null ? null : `#${String(entry.waitlist_position)}`,
    entry.priority_qualified === true ? 'Priority window' : null,
    entry.goalkeeper_willing === true ? 'Goalkeeper' : null,
    entry.preferred_positions.length > 0 ? entry.preferred_positions.join(', ') : null,
    entry.gender,
    entry.membership_status === 'active' ? null : entry.membership_status,
  ].filter((value): value is string => value !== null && value !== '');

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] py-2 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{fullName(entry)}</p>
        <p className="text-xs text-muted">
          Responded {respondedLabel(entry.responded_at)}
          {context.length > 0 ? ` · ${context.join(' · ')}` : ''}
        </p>
        {entry.override_reason === null ? null : (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Override: {entry.override_reason}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {entry.status === 'confirmed' ? null : (
          <DecisionButton
            leagueId={leagueId}
            matchId={matchId}
            membershipId={entry.membership_id}
            status="confirmed"
            label="Confirm"
          />
        )}
        {entry.status === 'waitlisted' ? null : (
          <DecisionButton
            leagueId={leagueId}
            matchId={matchId}
            membershipId={entry.membership_id}
            status="waitlisted"
            label="Waitlist"
          />
        )}
        {entry.status === 'not_selected' ? null : (
          <DecisionButton
            leagueId={leagueId}
            matchId={matchId}
            membershipId={entry.membership_id}
            status="not_selected"
            label="Not selected"
          />
        )}
      </div>
    </li>
  );
}

function Group({
  title,
  entries,
  leagueId,
  matchId,
  empty,
}: {
  title: string;
  entries: RosterAdminEntry[];
  leagueId: string;
  matchId: string;
  empty: string;
}) {
  return (
    <section className="surface-card p-4">
      <h3 className="text-sm font-semibold">
        {title} <span className="text-muted">({entries.length})</span>
      </h3>
      {entries.length === 0 ? (
        <p className="mt-2 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="mt-2">
          {entries.map((entry) => (
            <PlayerRow
              key={entry.signup_id}
              entry={entry}
              leagueId={leagueId}
              matchId={matchId}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Waitlist reordering.
 *
 * Submits the whole order rather than a "move up" delta, because the database
 * validates the ordering as a set — same match, same league, currently
 * waitlisted, complete and without duplicates. A stale form describing a
 * waitlist somebody has since left is refused rather than applied to a set it
 * no longer describes.
 */
function WaitlistOrder({
  entries,
  leagueId,
  matchId,
}: {
  entries: RosterAdminEntry[];
  leagueId: string;
  matchId: string;
}) {
  const [order, setOrder] = useState(entries.map((entry) => entry.membership_id));
  const [state, submit, pending] = useActionState(reorderWaitlistAction, null);

  const byId = new Map(entries.map((entry) => [entry.membership_id, entry]));

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    const moved = next[index];
    const displaced = next[target];
    if (moved === undefined || displaced === undefined) return;
    next[index] = displaced;
    next[target] = moved;
    setOrder(next);
  };

  if (entries.length === 0) {
    return null;
  }

  return (
    <form action={submit} className="surface-card flex flex-col gap-3 p-4">
      <h3 className="text-sm font-semibold">Waitlist order</h3>
      <FormError message={state?.ok === false ? state.message : undefined} />
      {state?.ok === true ? (
        <p role="status" className="text-sm font-medium text-pitch-600">
          Waitlist reordered.
        </p>
      ) : null}

      <input type="hidden" name="league_id" value={leagueId} />
      <input type="hidden" name="match_id" value={matchId} />

      <ol className="flex flex-col gap-1">
        {order.map((membershipId, index) => {
          const entry = byId.get(membershipId);
          if (entry === undefined) return null;
          return (
            <li key={membershipId} className="flex items-center justify-between gap-2">
              <input type="hidden" name="membership_ids" value={membershipId} />
              <span className="text-sm">
                {index + 1}. {fullName(entry)}
              </span>
              <span className="flex gap-1">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label={`Move ${fullName(entry)} up`}
                  className="min-h-9 rounded-lg border border-[var(--border-subtle)] px-2 text-xs disabled:opacity-40"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === order.length - 1}
                  aria-label={`Move ${fullName(entry)} down`}
                  className="min-h-9 rounded-lg border border-[var(--border-subtle)] px-2 text-xs disabled:opacity-40"
                >
                  ↓
                </button>
              </span>
            </li>
          );
        })}
      </ol>

      <SubmitButton pending={pending} variant="secondary">
        Save this order
      </SubmitButton>
    </form>
  );
}

/**
 * Manual addition.
 *
 * The picker lists memberships, never email addresses, so there is no way to
 * pull somebody into the league from here. The override reason appears always
 * but is required only once the deadline has passed — which the database
 * decides, since it is the one rule F-06 marks as overrideable.
 */
function ManualAdd({
  leagueId,
  matchId,
  members,
}: {
  leagueId: string;
  matchId: string;
  members: AddableMember[];
}) {
  const [state, submit, pending] = useActionState(addMemberToMatchAction, null);

  return (
    <form action={submit} className="surface-card flex flex-col gap-3 p-4">
      <h3 className="text-sm font-semibold">Add a member</h3>
      <FormError message={state?.ok === false ? state.message : undefined} />

      <input type="hidden" name="league_id" value={leagueId} />
      <input type="hidden" name="match_id" value={matchId} />

      {members.length === 0 ? (
        <p className="text-sm text-muted">
          Every active member is already on the roster or the waitlist.
        </p>
      ) : (
        <>
          <select name="membership_id" required className={inputClassName} aria-label="Member">
            {members.map((member) => (
              <option key={member.membership_id} value={member.membership_id}>
                {fullName(member)}
              </option>
            ))}
          </select>

          <select name="status" required className={inputClassName} aria-label="Add as">
            <option value="confirmed">Add to the confirmed roster</option>
            <option value="waitlisted">Add to the waitlist</option>
          </select>

          <input
            name="override_reason"
            maxLength={500}
            placeholder="Reason (required once signup has closed)"
            className={inputClassName}
            aria-label="Override reason"
          />

          <SubmitButton pending={pending} variant="secondary">
            Add to this match
          </SubmitButton>
        </>
      )}
    </form>
  );
}

function PublishRoster({
  leagueId,
  matchId,
  rosterRevision,
  finalizedAt,
}: {
  leagueId: string;
  matchId: string;
  rosterRevision: number;
  finalizedAt: string | null;
}) {
  const [state, submit, pending] = useActionState(finalizeRosterAction, null);

  return (
    <form action={submit} className="surface-card flex flex-col gap-3 p-4">
      <h3 className="text-sm font-semibold">Publish the roster</h3>
      <FormError message={state?.ok === false ? state.message : undefined} />

      <p className="text-sm text-muted">
        {finalizedAt === null
          ? 'Nobody has been told their outcome yet. Publishing sends every player who responded one message telling them whether they are playing, waitlisted or not selected.'
          : `Published ${new Date(finalizedAt).toLocaleDateString('en-GB')} · revision ${String(rosterRevision)}. Publishing again tells only the players whose outcome has changed.`}
      </p>

      <input type="hidden" name="league_id" value={leagueId} />
      <input type="hidden" name="match_id" value={matchId} />
      <SubmitButton pending={pending}>
        {finalizedAt === null ? 'Publish roster' : 'Publish changes'}
      </SubmitButton>
    </form>
  );
}

export function RosterWorkspace({
  leagueId,
  matchId,
  entries,
  addableMembers,
  capacity,
  rosterRevision,
  finalizedAt,
}: {
  leagueId: string;
  matchId: string;
  entries: RosterAdminEntry[];
  addableMembers: AddableMember[];
  capacity: number;
  rosterRevision: number;
  finalizedAt: string | null;
}) {
  const of = (status: SignupStatus) => entries.filter((entry) => entry.status === status);
  const confirmed = of('confirmed');
  const waitlisted = of('waitlisted');

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        {confirmed.length} of {capacity} confirmed ·{' '}
        {Math.max(0, capacity - confirmed.length)} open ·{' '}
        {waitlisted.length} waitlisted
      </p>

      <Group
        title="Requested a spot"
        entries={of('interested')}
        leagueId={leagueId}
        matchId={matchId}
        empty="Nobody is waiting on a decision."
      />
      <Group
        title="Confirmed"
        entries={confirmed}
        leagueId={leagueId}
        matchId={matchId}
        empty="Nobody is confirmed yet."
      />
      <Group
        title="Waitlist"
        entries={waitlisted}
        leagueId={leagueId}
        matchId={matchId}
        empty="The waitlist is empty."
      />
      <WaitlistOrder entries={waitlisted} leagueId={leagueId} matchId={matchId} />
      <Group
        title="Not selected"
        entries={of('not_selected')}
        leagueId={leagueId}
        matchId={matchId}
        empty="Nobody has been passed over."
      />
      <Group
        title="Cannot play"
        entries={of('not_available')}
        leagueId={leagueId}
        matchId={matchId}
        empty="Nobody has said they cannot play."
      />

      <ManualAdd leagueId={leagueId} matchId={matchId} members={addableMembers} />
      <PublishRoster
        leagueId={leagueId}
        matchId={matchId}
        rosterRevision={rosterRevision}
        finalizedAt={finalizedAt}
      />
    </div>
  );
}

'use client';

import { useActionState, useState } from 'react';
import { ActionTray, TrayButton } from '@/components/ui/button';
import { FormError, inputClassName, SubmitButton } from '@/components/ui/field';
import { PlayerAvatar } from '@/components/ui/player-avatar';
import {
  addMemberToMatchAction,
  finalizeRosterAction,
  promoteWaitlistedPlayerAction,
  reorderWaitlistAction,
  setSignupDecisionAction,
} from '@/server/actions/signups';
import type {
  AddableMember,
  MembershipAttendanceSummary,
  ReplacementState,
  RosterAdminEntry,
  SignupStatus,
} from '@/types/database';

/**
 * The administrator's roster workspace.
 *
 * Server-rendered data only: every field on `RosterAdminEntry` is one the
 * database projection already decided this administrator may see. Gender and
 * goalkeeper willingness arrive as `null` unless the league enabled those
 * fields, so this file never has to know the league settings — it renders what
 * it is given.
 *
 * Phase 7 supplies the attendance context 02 §11 lists and Phase 4 had to omit.
 * It is counts and a date, rendered as a sentence — see `AttendanceContext`
 * below for why there is no tier, colour or score, and why nothing on this
 * screen acts on it.
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

/**
 * One decision button. Every administrator action is a form post, never a fetch.
 *
 * Borderless, grouped into a single `ActionTray` — see that component for why
 * a per-button border was costing this screen its legibility. `emphasis` gives
 * the affirmative decision the only colour in the tray, which is enough to find
 * it without a filled green button on every row.
 */
function DecisionButton({
  leagueId,
  matchId,
  membershipId,
  status,
  label,
  emphasis = false,
}: {
  leagueId: string;
  matchId: string;
  membershipId: string;
  status: SignupStatus;
  label: string;
  emphasis?: boolean;
}) {
  const [state, submit, pending] = useActionState(setSignupDecisionAction, null);

  return (
    <form action={submit} className="inline">
      <input type="hidden" name="league_id" value={leagueId} />
      <input type="hidden" name="match_id" value={matchId} />
      <input type="hidden" name="membership_id" value={membershipId} />
      <input type="hidden" name="status" value={status} />
      <TrayButton
        type="submit"
        disabled={pending}
        tone={emphasis ? 'affirm' : 'neutral'}
        title={state?.ok === false ? state.message : undefined}
      >
        {pending ? '…' : label}
      </TrayButton>
    </form>
  );
}

/**
 * What this player's attendance record says, for an administrator choosing a
 * roster.
 *
 * FACTS, IN A SENTENCE. No badge, no colour scale, no tier, no ratio and no
 * score. 04 §1 settled that the product warns and the administrator decides,
 * and every one of those devices is the product deciding — a red dot at three
 * no-shows is a disciplinary threshold, and no approved document defines one.
 *
 * Nothing on this screen reads this value. It sits beside the name while a
 * human makes a choice, and the Confirm, Waitlist and Not selected buttons
 * behave identically whether it says nothing or twenty.
 */
function AttendanceContext({ summary }: { summary: MembershipAttendanceSummary | undefined }) {
  if (summary === undefined || summary.recorded_count === 0) {
    return null;
  }

  if (summary.no_show_count === 0) {
    return (
      <p className="text-xs text-muted">
        {summary.attended_count} of {summary.recorded_count} recorded matches attended
      </p>
    );
  }

  const last =
    summary.last_no_show_at === null
      ? null
      : new Date(summary.last_no_show_at).toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        });

  return (
    <p className="text-xs text-flag-700 dark:text-flag-200">
      Did not attend {summary.no_show_count} of {summary.recorded_count} recorded{' '}
      {summary.recorded_count === 1 ? 'match' : 'matches'}
      {last === null ? '' : `, most recently ${last}`}
    </p>
  );
}

function PlayerRow({
  entry,
  leagueId,
  matchId,
  summary,
}: {
  entry: RosterAdminEntry;
  leagueId: string;
  matchId: string;
  summary: MembershipAttendanceSummary | undefined;
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
    // Stacked on a phone, side by side from `sm`. Wrapping the two blocks into
    // one line was putting a name and a three-button tray in the same 320px,
    // which left roughly nine characters for the name.
    <li className="flex flex-col gap-2 border-b border-[var(--border-subtle)] py-2.5 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      {/* 32px sits inside the row's existing height: the block beside it is
          already two lines of text. The avatar is `shrink-0` and the text block
          keeps `min-w-0`, so a long name truncates rather than widening the
          row. */}
      <div className="flex min-w-0 items-center gap-2.5">
        <PlayerAvatar player={entry} size={32} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{fullName(entry)}</p>
          {/* Context first, "Responded" last. What the administrator is
              deciding on is that this player is a goalkeeper in the priority
              window; the timestamp is a tiebreak, and it was leading the line. */}
          <p className="text-xs text-muted">
            {context.length > 0 ? `${context.join(' · ')} · ` : ''}
            Responded {respondedLabel(entry.responded_at)}
          </p>
          {entry.override_reason === null ? null : (
            <p className="text-xs text-flag-700 dark:text-flag-200">
              Override: {entry.override_reason}
            </p>
          )}
          <AttendanceContext summary={summary} />
        </div>
      </div>
      <ActionTray className="self-end sm:self-auto">
        {entry.status === 'confirmed' ? null : (
          <DecisionButton
            leagueId={leagueId}
            matchId={matchId}
            membershipId={entry.membership_id}
            status="confirmed"
            label="Confirm"
            emphasis
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
      </ActionTray>
    </li>
  );
}

/**
 * One outcome bucket in the workspace.
 *
 * ── EMPTY BUCKETS COLLAPSE ─────────────────────────────────────────────────
 *
 * There are six of these, and on a healthy roster four of them are empty. The
 * screenshot review showed the result plainly: four full-width cards in a row
 * reading "Waitlist (0) — The waitlist is empty", "Not selected (0) — Nobody
 * has been passed over", and so on. That is four cards of chrome to say nothing
 * happened, between the administrator and the publish button.
 *
 * An empty bucket now renders as one quiet line instead of a card. It still
 * appears — knowing the waitlist is empty is worth something, and a section
 * that vanishes entirely makes people wonder where it went — but it no longer
 * costs the same visual weight as a bucket with eight people in it.
 */
function Group({
  title,
  entries,
  leagueId,
  matchId,
  empty,
  summaries,
}: {
  title: string;
  entries: RosterAdminEntry[];
  leagueId: string;
  matchId: string;
  empty: string;
  summaries: Record<string, MembershipAttendanceSummary>;
}) {
  if (entries.length === 0) {
    return (
      <p className="flex flex-wrap items-baseline gap-x-2 px-1 text-sm text-muted">
        <span className="font-semibold text-secondary">{title}</span>
        <span>{empty}</span>
      </p>
    );
  }

  return (
    <section className="surface-card p-4">
      <h3 className="text-sm font-semibold">
        {title} <span className="text-muted">({entries.length})</span>
      </h3>
      <ul className="mt-2">
        {entries.map((entry) => (
          <PlayerRow
            key={entry.signup_id}
            entry={entry}
            leagueId={leagueId}
            matchId={matchId}
            summary={summaries[entry.membership_id]}
          />
        ))}
      </ul>
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
              {/* The waitlist is the other place a player's identity is visible
                  to an administrator. 24px, because this row already carries two
                  44px reorder buttons and does not need to grow. */}
              <span className="flex min-w-0 items-center gap-2 text-sm">
                <span className="shrink-0 tabular-nums">{index + 1}.</span>
                <PlayerAvatar player={entry} size={24} />
                <span className="min-w-0 truncate">{fullName(entry)}</span>
              </span>
              <span className="flex shrink-0 gap-1">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label={`Move ${fullName(entry)} up`}
                  className="min-h-control rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-2 text-xs disabled:opacity-40"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === order.length - 1}
                  aria-label={`Move ${fullName(entry)} down`}
                  className="min-h-control rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-2 text-xs disabled:opacity-40"
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

/**
 * The open-spot panel, for administrator-controlled leagues.
 *
 * Automatic leagues never see this: their vacancy was filled inside the
 * transaction that created it, which is the whole point of that mode. Showing a
 * "promote" control there would offer an action with nothing to act on.
 *
 * The recommendation is the first *still-eligible* waitlisted player, re-derived
 * on every read rather than stored, so it cannot recommend somebody who has
 * since been suspended or let their guideline acceptance lapse. Promoting
 * anybody else needs a reason — F-09 makes the audit note a condition of
 * overriding the order, not a nicety — and that reason is administrator-only:
 * it never reaches the promoted player's notification or a push payload.
 */
function ReplacementPanel({
  leagueId,
  matchId,
  replacement,
  waitlisted,
}: {
  leagueId: string;
  matchId: string;
  replacement: ReplacementState;
  waitlisted: RosterAdminEntry[];
}) {
  const [state, submit, pending] = useActionState(promoteWaitlistedPlayerAction, null);
  const [targetId, setTargetId] = useState('');

  if (replacement.waitlist_mode === 'automatic') {
    return null;
  }

  const recommended = waitlisted.find(
    (entry) => entry.membership_id === replacement.recommended_membership_id,
  );
  const overriding = targetId !== '' && targetId !== replacement.recommended_membership_id;

  return (
    <section className="surface-card flex flex-col gap-3 p-4">
      <h3 className="text-sm font-semibold">
        Open spots <span className="text-muted">({replacement.open_spots})</span>
      </h3>

      <FormError message={state?.ok === false ? state.message : undefined} />
      {state?.ok === true ? (
        <p role="status" className="text-sm font-medium text-pitch-600">
          Player promoted.
        </p>
      ) : null}

      {replacement.open_spots === 0 ? (
        <p className="text-sm text-muted">The roster is full.</p>
      ) : waitlisted.length === 0 ? (
        <p className="text-sm text-muted">
          {replacement.open_spots} spot{replacement.open_spots === 1 ? '' : 's'} open, and
          nobody is waiting.
        </p>
      ) : (
        <form action={submit} className="flex flex-col gap-3">
          <input type="hidden" name="league_id" value={leagueId} />
          <input type="hidden" name="match_id" value={matchId} />

          <p className="text-sm">
            {recommended === undefined
              ? 'Nobody on the waitlist is currently eligible.'
              : `Recommended: ${fullName(recommended)} (position ${String(
                  recommended.waitlist_position ?? 0,
                )}).`}
          </p>

          <select
            name="membership_id"
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            className={inputClassName}
            aria-label="Player to promote"
          >
            <option value="">
              {recommended === undefined
                ? 'Choose a player'
                : `Recommended — ${fullName(recommended)}`}
            </option>
            {waitlisted.map((entry) => (
              <option key={entry.membership_id} value={entry.membership_id}>
                {String(entry.waitlist_position ?? 0)}. {fullName(entry)}
              </option>
            ))}
          </select>

          {overriding ? (
            <input
              name="reason"
              required
              maxLength={500}
              placeholder="Why this player instead of the recommendation?"
              className={inputClassName}
              aria-label="Override reason"
            />
          ) : null}

          <SubmitButton pending={pending}>Promote to the roster</SubmitButton>
        </form>
      )}
    </section>
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
  attendanceSummaries,
  addableMembers,
  capacity,
  rosterRevision,
  finalizedAt,
  replacement,
}: {
  leagueId: string;
  matchId: string;
  entries: RosterAdminEntry[];
  attendanceSummaries: Record<string, MembershipAttendanceSummary>;
  addableMembers: AddableMember[];
  capacity: number;
  rosterRevision: number;
  finalizedAt: string | null;
  replacement: ReplacementState | null;
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
        summaries={attendanceSummaries}
        empty="Nobody is waiting on a decision."
      />
      <Group
        title="Confirmed"
        entries={confirmed}
        leagueId={leagueId}
        matchId={matchId}
        summaries={attendanceSummaries}
        empty="Nobody is confirmed yet."
      />
      <Group
        title="Waitlist"
        entries={waitlisted}
        leagueId={leagueId}
        matchId={matchId}
        summaries={attendanceSummaries}
        empty="The waitlist is empty."
      />
      <WaitlistOrder entries={waitlisted} leagueId={leagueId} matchId={matchId} />
      {replacement === null ? null : (
        <ReplacementPanel
          leagueId={leagueId}
          matchId={matchId}
          replacement={replacement}
          waitlisted={waitlisted}
        />
      )}
      <Group
        title="Not selected"
        entries={of('not_selected')}
        leagueId={leagueId}
        matchId={matchId}
        summaries={attendanceSummaries}
        empty="Nobody has been passed over."
      />
      <Group
        title="Cannot play"
        entries={of('not_available')}
        leagueId={leagueId}
        matchId={matchId}
        summaries={attendanceSummaries}
        empty="Nobody has said they cannot play."
      />
      <Group
        title="Cancelled"
        entries={[...of('canceled'), ...of('withdrawn_late')]}
        leagueId={leagueId}
        matchId={matchId}
        summaries={attendanceSummaries}
        empty="Nobody has cancelled."
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

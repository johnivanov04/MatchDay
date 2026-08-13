'use client';

import { useActionState, useState } from 'react';
import { FormError, inputClassName, SubmitButton } from '@/components/ui/field';
import {
  cancelSpotAction,
  joinMatchAction,
  markUnavailableAction,
  requestSpotAction,
} from '@/server/actions/signups';
import type { SelectionMode, SignupEligibility, SignupOutcome } from '@/types/database';

/**
 * The player's own signup controls and status.
 *
 * Everything rendered here is about the caller: their outcome, and — when
 * waitlisted — their own position. There is no prop on any component in this
 * file that could carry another player's status or place in the queue, which is
 * what makes "a player cannot infer another player's waitlist position" true of
 * the client bundle and not only of the API.
 */

/** Why signup is unavailable, phrased for the person who cannot use it. */
const BLOCKED_MESSAGES: Record<Exclude<SignupEligibility, 'ELIGIBLE'>, string> = {
  AUTH_REQUIRED: 'Sign in to respond to this match.',
  MEMBERSHIP_REQUIRED: 'You are not an active member of this league.',
  GUIDELINES_NOT_ACCEPTED:
    'Accept the league guidelines before signing up. You will find them under Guidelines.',
  MATCH_NOT_OPEN: 'This match is not accepting responses.',
  SIGNUP_CLOSED: 'Signup for this match has closed.',
};

export function SignupStatusBadge({ outcome }: { outcome: SignupOutcome | null }) {
  if (outcome === null) {
    return null;
  }

  // Wording is the product requirement, not decoration: 02 §11 requires the
  // interface to say explicitly that an approved-mode request is *not* a
  // confirmed spot, because the whole failure mode of the old email workflow
  // was people turning up believing they were on the list.
  const [label, detail, tone] = ((): [string, string, string] => {
    switch (outcome.status) {
      case 'confirmed':
        return ['You are playing', 'Your spot is confirmed.', 'pitch'];
      case 'waitlisted':
        return [
          `Waitlisted — position ${String(outcome.waitlist_position ?? 0)}`,
          'You will be told if a spot opens.',
          'amber',
        ];
      case 'interested':
        return [
          'Selection pending',
          'You have requested a spot. This is not a confirmed spot — the administrator picks the roster.',
          'amber',
        ];
      case 'not_selected':
        return ['Not selected', 'You were not picked for this match.', 'neutral'];
      case 'not_available':
        return ['You said you cannot play', 'You are not on the roster for this match.', 'neutral'];
      case 'canceled':
        return ['Cancelled', 'You cancelled and are no longer on the roster.', 'neutral'];
      case 'withdrawn_late':
        // Deliberately not "no-show". A late withdrawal is a cancellation after
        // the cutoff; whether somebody failed to turn up is an attendance
        // judgement nobody has made, and labelling it here would pre-judge it.
        return [
          'Withdrew late',
          'You cancelled after the cutoff, so your league administrator was told.',
          'amber',
        ];
      default:
        return ['Recorded', 'Your response has been recorded.', 'neutral'];
    }
  })();

  const styles =
    tone === 'pitch'
      ? 'border-pitch-500/40 bg-pitch-50 text-pitch-900 dark:bg-pitch-900/40 dark:text-pitch-50'
      : tone === 'amber'
        ? 'border-amber-400/50 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100'
        : 'border-[var(--border-subtle)]';

  return (
    <div role="status" className={`rounded-lg border px-3 py-2 ${styles}`}>
      <p className="text-sm font-semibold">{label}</p>
      <p className="mt-0.5 text-sm">{detail}</p>
    </div>
  );
}

/**
 * Cancelling a spot, or leaving the waitlist.
 *
 * Two steps on purpose. Releasing a confirmed spot after the cutoff is recorded
 * as a late withdrawal and tells the administrator, so the consequence is shown
 * *before* the irreversible press rather than reported afterwards.
 *
 * `isLate` here is presentation only. The classification that gets stored is
 * decided by the database from the match's own cutoff and its own clock — this
 * component could not lie about it if it tried, because no boolean, timestamp
 * or classification is submitted.
 */
function CancelSpotControl({
  matchId,
  holdsSpot,
  waitlistPosition,
  cutoffLabel,
  isLate,
}: {
  matchId: string;
  holdsSpot: boolean;
  waitlistPosition: number | null;
  cutoffLabel: string;
  isLate: boolean;
}) {
  const [state, submit, pending] = useActionState(cancelSpotAction, null);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="flex flex-col gap-2">
        <FormError message={state?.ok === false ? state.message : undefined} />
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="inline-flex min-h-11 w-fit items-center justify-center rounded-lg border border-[var(--border-subtle)] px-4 py-2.5 text-sm font-semibold"
        >
          {holdsSpot ? 'Cancel my spot' : 'Leave the waitlist'}
        </button>
        {holdsSpot ? (
          <p className="text-xs text-muted">Cancellation cutoff: {cutoffLabel}.</p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-3 rounded-lg border border-[var(--border-subtle)] p-3">
      <input type="hidden" name="match_id" value={matchId} />

      <FormError message={state?.ok === false ? state.message : undefined} />

      {holdsSpot ? (
        isLate ? (
          <p
            role="status"
            className="rounded-lg border border-amber-400/50 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
          >
            <strong>This is a late cancellation.</strong> The cutoff was {cutoffLabel}. Your
            league administrator will be told. This is not recorded as a no-show.
          </p>
        ) : (
          <p role="status" className="text-sm">
            Cancelling now is <strong>on time</strong> — the cutoff is {cutoffLabel}. Your spot
            will be offered to somebody else.
          </p>
        )
      ) : (
        <p role="status" className="text-sm">
          You are number {waitlistPosition ?? 0} on the waitlist. Leaving gives up that place.
        </p>
      )}

      <label htmlFor="cancel-reason" className="flex flex-col gap-1.5 text-sm font-medium">
        Reason
        <span className="text-xs font-normal text-muted">
          Optional, and shown only to your league administrator.
        </span>
        <input
          id="cancel-reason"
          name="reason"
          maxLength={500}
          className={inputClassName}
          placeholder="Injured, working late…"
        />
      </label>

      <div className="flex flex-wrap gap-2">
        <SubmitButton pending={pending}>
          {holdsSpot ? 'Yes, cancel my spot' : 'Yes, leave the waitlist'}
        </SubmitButton>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="inline-flex min-h-11 items-center justify-center rounded-lg border border-[var(--border-subtle)] px-4 py-2.5 text-sm font-semibold"
        >
          Keep my place
        </button>
      </div>
    </form>
  );
}

export function SignupControls({
  matchId,
  selectionMode,
  eligibility,
  outcome,
  cancellationCutoffLabel,
  cancellationIsLate,
}: {
  matchId: string;
  selectionMode: SelectionMode;
  eligibility: SignupEligibility;
  outcome: SignupOutcome | null;
  cancellationCutoffLabel: string;
  cancellationIsLate: boolean;
}) {
  const [joinState, join, joining] = useActionState(joinMatchAction, null);
  const [requestState, request, requesting] = useActionState(requestSpotAction, null);
  const [unavailableState, markUnavailable, marking] = useActionState(markUnavailableAction, null);

  const failure = [joinState, requestState, unavailableState].find(
    (state) => state?.ok === false,
  );

  const status = outcome?.status ?? null;
  const holdsSpot = status === 'confirmed';
  const holdsWaitlistPlace = status === 'waitlisted';
  const alreadyResponded = status === 'confirmed' || status === 'waitlisted' || status === 'interested';

  /**
   * ELIGIBILITY GOVERNS JOINING, NOT LEAVING.
   *
   * Returning early on any non-`ELIGIBLE` code — which is what this did — meant
   * a confirmed player lost the cancel button the moment the administrator
   * published the roster (`MATCH_NOT_OPEN`) or signup closed (`SIGNUP_CLOSED`).
   * Those are precisely the hours when withdrawing matters most: the roster is
   * set, the teams may be out, and the administrator needs to know now to find
   * a replacement. `cancel_spot()` has always allowed it — it has no
   * match-status gate at all, deliberately — so the database was willing and
   * only the interface refused.
   *
   * The other codes still stop everything, because they mean the caller is not
   * entitled to a place at all rather than that the match has moved on:
   * `MEMBERSHIP_REQUIRED`, `GUIDELINES_NOT_ACCEPTED` and `AUTH_REQUIRED`.
   * A canceled match never reaches this component.
   */
  const closedButStillLeavable = eligibility === 'MATCH_NOT_OPEN' || eligibility === 'SIGNUP_CLOSED';
  const mayCancel = (holdsSpot || holdsWaitlistPlace) && closedButStillLeavable;

  if (eligibility !== 'ELIGIBLE' && !mayCancel) {
    return (
      <p role="status" className="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm">
        {BLOCKED_MESSAGES[eligibility]}
      </p>
    );
  }

  // Closed to new signups, but this player still holds a place and may leave it.
  if (mayCancel) {
    return (
      <div className="flex flex-col gap-3">
        {/* Its own wording, not `BLOCKED_MESSAGES`. "This match is not
            accepting responses" sitting directly above a Cancel my spot button
            contradicts it, and the player has to work out which of the two to
            believe. */}
        <p
          role="status"
          className="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm"
        >
          {eligibility === 'SIGNUP_CLOSED'
            ? 'Signup has closed, so nobody new can join.'
            : 'The roster is set, so nobody new can join.'}{' '}
          {holdsSpot
            ? 'You still have your spot — if you cannot make it, cancel below so your administrator can find a replacement.'
            : 'You are still on the waitlist and can leave it below.'}
        </p>
        <CancelSpotControl
          matchId={matchId}
          holdsSpot={holdsSpot}
          waitlistPosition={outcome?.waitlist_position ?? null}
          cutoffLabel={cancellationCutoffLabel}
          isLate={cancellationIsLate}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <FormError message={failure?.ok === false ? failure.message : undefined} />

      {alreadyResponded ? null : (
        <form action={selectionMode === 'first_come' ? join : request}>
          <input type="hidden" name="match_id" value={matchId} />
          <SubmitButton pending={joining || requesting}>
            {selectionMode === 'first_come' ? 'Join match' : 'Request a spot'}
          </SubmitButton>
        </form>
      )}

      {/*
        Cancelling is for somebody holding a place — a spot or a queue position.
        "Can't play" stays the answer for everybody else: it releases nothing,
        so it needs no cutoff, no confirmation and no administrator alert.
      */}
      {holdsSpot || holdsWaitlistPlace ? (
        <CancelSpotControl
          matchId={matchId}
          holdsSpot={holdsSpot}
          waitlistPosition={outcome?.waitlist_position ?? null}
          cutoffLabel={cancellationCutoffLabel}
          isLate={cancellationIsLate}
        />
      ) : (
        <form action={markUnavailable}>
          <input type="hidden" name="match_id" value={matchId} />
          <SubmitButton pending={marking} variant="secondary">
            {status === 'not_available' ? 'Still cannot play' : 'Can’t play'}
          </SubmitButton>
        </form>
      )}
    </div>
  );
}

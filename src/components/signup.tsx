'use client';

import { useActionState } from 'react';
import { FormError, SubmitButton } from '@/components/ui/field';
import {
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

export function SignupControls({
  matchId,
  selectionMode,
  eligibility,
  outcome,
}: {
  matchId: string;
  selectionMode: SelectionMode;
  eligibility: SignupEligibility;
  outcome: SignupOutcome | null;
}) {
  const [joinState, join, joining] = useActionState(joinMatchAction, null);
  const [requestState, request, requesting] = useActionState(requestSpotAction, null);
  const [unavailableState, markUnavailable, marking] = useActionState(markUnavailableAction, null);

  const failure = [joinState, requestState, unavailableState].find(
    (state) => state?.ok === false,
  );

  if (eligibility !== 'ELIGIBLE') {
    return (
      <p role="status" className="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm">
        {BLOCKED_MESSAGES[eligibility]}
      </p>
    );
  }

  const status = outcome?.status ?? null;
  const holdsSpot = status === 'confirmed';
  const alreadyResponded = status === 'confirmed' || status === 'waitlisted' || status === 'interested';

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

      {holdsSpot ? (
        // A confirmed player would normally see "Cancel my spot". Releasing a
        // spot means classifying the cancellation against the cutoff, alerting
        // the administrator and offering the place to somebody else — none of
        // which exists yet. So this states the position plainly instead of
        // offering a control that would appear to work and quietly do half the
        // job.
        <p className="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs text-muted">
          Need to drop out? Cancelling your own spot is not available yet — please contact your
          league administrator.
        </p>
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

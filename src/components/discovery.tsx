'use client';

import { useActionState, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { inputClassName, SubmitButton } from '@/components/ui/field';
import { CheckIcon, ClockIcon, ShieldIcon } from '@/components/ui/icon';
import {
  requestToJoinLeagueAction,
  withdrawJoinRequestAction,
} from '@/server/actions/membership';
import type { SearchableLeaguePublicRow } from '@/types/database';

/**
 * A searchable-league card.
 *
 * The props are exactly the seven columns of `searchable_leagues_public`, so
 * this component structurally cannot render a field the public projection does
 * not publish.
 *
 * ── WHY THE JOIN ACTION IS QUIET ───────────────────────────────────────────
 *
 * The join form used to be open on every card, so a search returning eight
 * leagues rendered eight text inputs and eight filled green buttons: a wall of
 * primary CTAs on a screen whose actual job is *reading about leagues* and
 * deciding which one to ask about. Filled green means "the thing this screen is
 * for", and it cannot mean that eight times at once.
 *
 * So each card offers one bordered secondary button, and the note field and the
 * filled confirm appear only in the card somebody has actually chosen — where
 * there is exactly one primary action, which is what primary is for.
 */
export function PublicLeagueCard({
  league,
  relationship,
}: {
  league: SearchableLeaguePublicRow;
  relationship: 'none' | 'member' | 'requested';
}) {
  const [state, submit, pending] = useActionState(requestToJoinLeagueAction, null);
  const [asking, setAsking] = useState(false);

  return (
    <li className="surface-card animate-rise flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden="true"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-pitch-50 text-pitch-700 dark:bg-pitch-900/50 dark:text-pitch-300"
          >
            <ShieldIcon size={19} />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="text-[0.9375rem] font-semibold leading-snug">{league.name}</h3>
            <p className="text-sm text-muted">
              {league.sport_label} · {league.general_area}
            </p>
          </div>
        </div>

        {relationship === 'member' ? (
          <Badge tone="live" dot>
            Member
          </Badge>
        ) : relationship === 'requested' || state?.ok === true ? (
          <Badge tone="pending" dot>
            Requested
          </Badge>
        ) : null}
      </div>

      {league.description === '' ? null : (
        <p className="text-sm leading-relaxed text-secondary">{league.description}</p>
      )}

      {league.typical_schedule === null ? null : (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <ClockIcon size={14} />
          Usually plays: {league.typical_schedule}
        </p>
      )}

      {relationship === 'member' ? (
        <p className="flex items-center gap-1.5 text-sm font-medium text-pitch-700 dark:text-pitch-300">
          <CheckIcon size={16} />
          You are already a member.
        </p>
      ) : relationship === 'requested' || state?.ok === true ? (
        <p className="flex items-center gap-1.5 text-sm font-medium text-pitch-700 dark:text-pitch-300">
          <ClockIcon size={16} />
          Request sent — awaiting approval.
        </p>
      ) : asking ? (
        <form action={submit} className="flex flex-col gap-2">
          <input type="hidden" name="league_id" value={league.id} />
          <label htmlFor={`message-${league.id}`} className="sr-only">
            Message to the administrator
          </label>
          {/* `autoFocus` because the button that opened this row has just
              unmounted: without moving the caret here a keyboard user's focus
              falls back to the body and they tab in from the top of the page. */}
          <input
            id={`message-${league.id}`}
            name="message"
            maxLength={500}
            placeholder="Optional note for the administrator"
            className={inputClassName}
            autoFocus
          />
          <div className="flex items-center gap-2">
            <SubmitButton pending={pending} block={false}>
              Send request
            </SubmitButton>
            <Button variant="ghost" onClick={() => setAsking(false)} disabled={pending}>
              Cancel
            </Button>
          </div>
          {state?.ok === false ? (
            <p role="alert" className="text-sm font-medium text-whistle-600 dark:text-whistle-300">
              {state.message}
            </p>
          ) : null}
        </form>
      ) : (
        <div>
          <Button variant="secondary" onClick={() => setAsking(true)}>
            Request to join
          </Button>
        </div>
      )}
    </li>
  );
}

export function WithdrawRequestButton({ requestId }: { requestId: string }) {
  const [state, submit, pending] = useActionState(withdrawJoinRequestAction, null);

  return (
    <form action={submit} className="inline shrink-0">
      <input type="hidden" name="request_id" value={requestId} />
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className="press inline-flex min-h-control items-center rounded-[var(--radius-md)] px-2.5 py-2 text-sm font-medium text-secondary hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-55"
      >
        {pending ? 'Withdrawing…' : 'Withdraw'}
      </button>
      {state?.ok === false ? (
        <span role="alert" className="ml-2 text-sm text-whistle-600 dark:text-whistle-300">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

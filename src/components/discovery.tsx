'use client';

import { useActionState } from 'react';
import { inputClassName } from '@/components/ui/field';
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
 */
export function PublicLeagueCard({
  league,
  relationship,
}: {
  league: SearchableLeaguePublicRow;
  relationship: 'none' | 'member' | 'requested';
}) {
  const [state, submit, pending] = useActionState(requestToJoinLeagueAction, null);

  return (
    <li className="surface-card flex flex-col gap-3 p-4">
      <div>
        <h3 className="text-base font-semibold">{league.name}</h3>
        <p className="text-sm text-muted">
          {league.sport_label} · {league.general_area}
        </p>
      </div>

      <p className="text-sm">{league.description}</p>

      {league.typical_schedule === null ? null : (
        <p className="text-xs text-muted">Usually plays: {league.typical_schedule}</p>
      )}

      {relationship === 'member' ? (
        <p className="text-sm font-medium text-pitch-600">You are already a member.</p>
      ) : relationship === 'requested' || state?.ok === true ? (
        <p className="text-sm font-medium text-pitch-600">Request sent — awaiting approval.</p>
      ) : (
        <form action={submit} className="flex flex-col gap-2">
          <input type="hidden" name="league_id" value={league.id} />
          <label htmlFor={`message-${league.id}`} className="sr-only">
            Message to the administrator
          </label>
          <input
            id={`message-${league.id}`}
            name="message"
            maxLength={500}
            placeholder="Optional note for the administrator"
            className={inputClassName}
          />
          <button
            type="submit"
            disabled={pending}
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-pitch-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-pitch-700 disabled:opacity-60"
          >
            {pending ? 'Sending…' : 'Request to join'}
          </button>
          {state?.ok === false ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {state.message}
            </p>
          ) : null}
        </form>
      )}
    </li>
  );
}

export function WithdrawRequestButton({ requestId }: { requestId: string }) {
  const [state, submit, pending] = useActionState(withdrawJoinRequestAction, null);

  return (
    <form action={submit} className="inline">
      <input type="hidden" name="request_id" value={requestId} />
      <button
        type="submit"
        disabled={pending}
        className="text-sm font-medium underline underline-offset-4 disabled:opacity-60"
      >
        {pending ? 'Withdrawing…' : 'Withdraw'}
      </button>
      {state?.ok === false ? (
        <span role="alert" className="ml-2 text-sm text-red-600 dark:text-red-400">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

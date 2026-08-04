'use client';

import { useActionState } from 'react';
import { switchActiveLeagueAction } from '@/server/actions/active-league';
import type { LeagueSwitcherModel } from '@/lib/leagues/league-context';

/**
 * League-switcher shell.
 *
 * Pending and suspended memberships are listed separately and are not
 * selectable (PRD §11): the user can see where they stand without the app
 * pretending they can act there. The selection is persisted server-side, so it
 * survives sessions and devices.
 */
export function LeagueSwitcher({
  model,
  activeLeagueId,
}: {
  model: LeagueSwitcherModel;
  activeLeagueId: string | null;
}) {
  const [state, submit, pending] = useActionState(switchActiveLeagueAction, null);

  if (model.active.length === 0 && model.pending.length === 0 && model.suspended.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      {model.active.length > 1 ? (
        <form action={submit} className="flex items-center gap-2">
          <label htmlFor="league_id" className="sr-only">
            Active league
          </label>
          <select
            id="league_id"
            name="league_id"
            defaultValue={activeLeagueId ?? ''}
            className="min-h-11 flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 text-sm font-medium"
          >
            {model.active.map(({ league, membership }) => (
              <option key={league.id} value={league.id}>
                {league.name}
                {membership.role === 'league_admin' ? ' (administrator)' : ''}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={pending}
            className="min-h-11 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm font-semibold disabled:opacity-60"
          >
            {pending ? 'Switching…' : 'Switch'}
          </button>
        </form>
      ) : null}

      {state?.ok === false ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.message}
        </p>
      ) : null}

      {model.pending.length > 0 ? (
        <p className="text-xs text-muted">
          Awaiting approval:{' '}
          {model.pending.map(({ league }) => league.name).join(', ')}
        </p>
      ) : null}

      {model.suspended.length > 0 ? (
        <p className="text-xs text-muted">
          Suspended in: {model.suspended.map(({ league }) => league.name).join(', ')}
        </p>
      ) : null}
    </div>
  );
}

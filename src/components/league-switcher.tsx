'use client';

import { useActionState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Section } from '@/components/ui/card';
import { inputClassName } from '@/components/ui/field';
import { switchActiveLeagueAction } from '@/server/actions/active-league';
import type { LeagueSwitcherModel } from '@/lib/leagues/league-context';

/**
 * League-switcher.
 *
 * Pending and suspended memberships are listed separately and are not
 * selectable (PRD §11): the user can see where they stand without the app
 * pretending they can act there. The selection is persisted server-side, so it
 * survives sessions and devices.
 *
 * ── WHY IT MOVED ───────────────────────────────────────────────────────────
 *
 * It used to sit in the global header, so a `<select>` and a Switch button were
 * on every screen in the product — a permanent 44px of chrome for an action
 * somebody takes once a week at most. It now lives on the dashboard, which is
 * where you already go to decide what you are working on, and the header shows
 * the active league as a single readable strip instead.
 *
 * The pending and suspended notes gained badges. Being suspended in a league is
 * a thing somebody needs to notice; it was previously an 11px grey sentence
 * beneath a select box.
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

  const showSwitcher = model.active.length > 1;

  return (
    <Section
      {...(showSwitcher ? { title: 'Switch league', description: 'Choose which league MatchDay shows you.' } : {})}
    >
      {showSwitcher ? (
        <form action={submit} className="surface-card flex items-center gap-2 p-3">
          <label htmlFor="league_id" className="sr-only">
            Active league
          </label>
          <select
            id="league_id"
            name="league_id"
            defaultValue={activeLeagueId ?? ''}
            className={`${inputClassName} flex-1 font-medium`}
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
            aria-busy={pending}
            className="press inline-flex min-h-control shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-pitch-600 px-4 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-card)] hover:bg-pitch-700 disabled:pointer-events-none disabled:opacity-55 dark:bg-pitch-500 dark:text-pitch-950 dark:hover:bg-pitch-400"
          >
            {pending ? 'Switching…' : 'Switch'}
          </button>
        </form>
      ) : null}

      {state?.ok === false ? (
        <p role="alert" className="text-sm font-medium text-whistle-600 dark:text-whistle-300">
          {state.message}
        </p>
      ) : null}

      {model.pending.length > 0 || model.suspended.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {model.pending.map(({ league }) => (
            <li
              key={league.id}
              className="surface-card flex items-center justify-between gap-3 px-3.5 py-3"
            >
              <span className="min-w-0 truncate text-sm font-medium">{league.name}</span>
              <Badge tone="pending" dot>
                Awaiting approval
              </Badge>
            </li>
          ))}
          {model.suspended.map(({ league }) => (
            <li
              key={league.id}
              className="surface-card flex items-center justify-between gap-3 px-3.5 py-3"
            >
              <span className="min-w-0 truncate text-sm font-medium">{league.name}</span>
              <Badge tone="off" dot>
                Suspended
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

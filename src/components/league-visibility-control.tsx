'use client';

import { useActionState } from 'react';
import { setLeagueVisibilityAction } from '@/server/actions/leagues';
import type { LeagueVisibility } from '@/types/database';

/**
 * Private ⇄ searchable.
 *
 * Kept apart from the settings form because it is the only setting that changes
 * who outside the league can see it exists. The copy spells out exactly which
 * fields become public, so the choice is informed rather than a toggle whose
 * consequences are buried in a policy document.
 */
export function LeagueVisibilityControl({
  leagueId,
  visibility,
}: {
  leagueId: string;
  visibility: LeagueVisibility;
}) {
  const [state, submit, pending] = useActionState(setLeagueVisibilityAction, null);
  const nextVisibility: LeagueVisibility = visibility === 'private' ? 'searchable' : 'private';

  return (
    <section className="surface-card flex flex-col gap-3 p-4">
      <div>
        <h2 className="text-base font-semibold">Visibility</h2>
        <p className="mt-1 text-sm text-muted">
          {visibility === 'private'
            ? 'Private. This league does not appear in search; people join by invitation only.'
            : 'Searchable. Anyone can find this league and ask to join.'}
        </p>
      </div>

      <div className="rounded-lg border border-[var(--border-subtle)] p-3 text-xs text-muted">
        <p className="font-medium text-[var(--text-primary)]">
          A searchable league publishes exactly these:
        </p>
        <p className="mt-1">name, general area, sport or format, typical schedule, description.</p>
        <p className="mt-1">
          Never published: your member list, usual location, capacity and match settings, or any
          player&rsquo;s profile.
        </p>
      </div>

      <form action={submit}>
        <input type="hidden" name="league_id" value={leagueId} />
        <input type="hidden" name="visibility" value={nextVisibility} />
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-11 items-center justify-center rounded-lg border border-[var(--border-subtle)] px-4 py-2.5 text-sm font-semibold disabled:opacity-60"
        >
          {pending
            ? 'Updating…'
            : visibility === 'private'
              ? 'Make this league searchable'
              : 'Make this league private'}
        </button>
      </form>

      {state?.ok === false ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.message}
        </p>
      ) : null}
    </section>
  );
}

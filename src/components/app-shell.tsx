import Link from 'next/link';
import type { ReactNode } from 'react';
import { LeagueSwitcher } from '@/components/league-switcher';
import type { LeagueContext } from '@/lib/leagues/active-league';

/**
 * Authenticated application shell: identity, active league, navigation.
 *
 * Deliberately thin. Everything a player actually comes here for — matches,
 * rosters, notifications — belongs to later phases, and stubbing those links
 * now would promise screens that do not exist.
 */
export function AppShell({
  displayName,
  leagueContext,
  children,
}: {
  displayName: string;
  leagueContext: LeagueContext;
  children: ReactNode;
}) {
  const activeLeague = leagueContext.active;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col">
      <header className="flex flex-col gap-3 border-b border-[var(--border-subtle)] px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <Link href="/dashboard" className="text-base font-bold">
            Matchday
          </Link>
          <div className="flex items-center gap-3">
            <Link href="/profile" className="text-sm font-medium underline underline-offset-4">
              {displayName}
            </Link>
            <form action="/auth/sign-out" method="post">
              <button
                type="submit"
                className="min-h-9 rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-sm"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-xs uppercase tracking-wide text-muted">Active league</p>
          <p className="text-sm font-semibold">
            {activeLeague === null ? 'No active league yet' : activeLeague.league.name}
          </p>
        </div>

        <LeagueSwitcher
          model={leagueContext.switcher}
          activeLeagueId={activeLeague?.league.id ?? null}
        />
      </header>

      <main id="main" className="flex flex-1 flex-col gap-6 px-5 py-6">
        {children}
      </main>

      <footer className="px-5 py-6 text-xs text-muted">
        Phase 1 foundation — matches, rosters and notifications arrive in later phases.
      </footer>
    </div>
  );
}

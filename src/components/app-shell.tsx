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
  unreadNotifications,
  children,
}: {
  displayName: string;
  leagueContext: LeagueContext;
  unreadNotifications: number;
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
            <Link
              href="/notifications"
              className="flex items-center gap-1.5 text-sm font-medium underline underline-offset-4"
              aria-label={
                unreadNotifications === 0
                  ? 'Notifications'
                  : `Notifications, ${unreadNotifications} unread`
              }
            >
              Inbox
              {unreadNotifications > 0 ? (
                <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-pitch-600 px-1.5 py-0.5 text-xs font-semibold text-white no-underline">
                  {unreadNotifications > 99 ? '99+' : unreadNotifications}
                </span>
              ) : null}
            </Link>
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

        <nav aria-label="League navigation" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <Link href="/leagues/discover" className="underline underline-offset-4">
            Find a league
          </Link>
          <Link href="/leagues/new" className="underline underline-offset-4">
            Create a league
          </Link>
          {/* Administrator links appear only for the active league, and only
              when the session's own membership says so. This is presentation,
              not authorization — every target re-checks server-side. */}
          {activeLeague === null ? null : (
            <>
              <Link
                href={`/leagues/${activeLeague.league.slug}/matches`}
                className="underline underline-offset-4"
              >
                Matches
              </Link>
              <Link
                href={`/leagues/${activeLeague.league.slug}/guidelines`}
                className="underline underline-offset-4"
              >
                Guidelines
              </Link>
            </>
          )}
          {activeLeague !== null && activeLeague.membership.role === 'league_admin' ? (
            <>
              <Link
                href={`/leagues/${activeLeague.league.slug}/members`}
                className="underline underline-offset-4"
              >
                Members
              </Link>
              <Link
                href={`/leagues/${activeLeague.league.slug}/settings`}
                className="underline underline-offset-4"
              >
                Settings
              </Link>
            </>
          ) : null}
          <Link href="/settings/devices" className="underline underline-offset-4">
            Alerts
          </Link>
        </nav>
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

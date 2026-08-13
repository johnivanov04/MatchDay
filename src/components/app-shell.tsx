import Link from 'next/link';
import type { ReactNode } from 'react';
import { LeagueSwitcher } from '@/components/league-switcher';
import { SupportContact } from '@/components/support-contact';
import type { LeagueContext } from '@/lib/leagues/active-league';

/**
 * Authenticated application shell: identity, active league, navigation, and the
 * one always-present route to a human.
 *
 * The navigation is derived from the session's own membership and is
 * presentation only — every target re-checks authorization server-side, so a
 * link that should not be there would still refuse.
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
        {/*
          `flex-wrap` and a truncating name, because this row is on every screen
          and was the one thing making the whole document scroll sideways at
          320px: "Matchday · Inbox 3 · Christopher · Sign out" does not fit on
          an iPhone SE, and a header that overflows takes every page with it.
          Wrapping costs a line on the narrowest phones and nothing above them.
        */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <Link href="/dashboard" className="text-base font-bold">
            Matchday
          </Link>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
            <Link
              href="/notifications"
              className="flex shrink-0 items-center gap-1.5 text-sm font-medium underline underline-offset-4"
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
            {/* The one element here with no length limit, so it is the one that
                gives way. The full name is still on the profile page. */}
            <Link
              href="/profile"
              className="min-w-0 truncate text-sm font-medium underline underline-offset-4"
            >
              {displayName}
            </Link>
            <form action="/auth/sign-out" method="post" className="shrink-0">
              <button
                type="submit"
                className="min-h-11 rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-sm"
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

      {/* The one always-present route to a human. Quiet by design — small,
          muted, at the bottom — but on every authenticated page, because the
          person who needs it is by definition somebody the product has already
          failed. Renders nothing at all when no support address is configured.

          The old text here announced "Phase 1 foundation — matches, rosters and
          notifications arrive in later phases", which stopped being true four
          phases ago. */}
      <footer className="px-5 py-6 text-xs text-muted">
        <SupportContact />
      </footer>
    </div>
  );
}

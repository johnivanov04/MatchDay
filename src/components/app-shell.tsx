import Link from 'next/link';
import type { ReactNode } from 'react';
import { BottomNav, HeaderNav, type NavTab } from '@/components/bottom-nav';
import { LeagueStrip } from '@/components/league-strip';
import { SupportContact } from '@/components/support-contact';
import { Avatar } from '@/components/ui/avatar';
import { BrandLockup } from '@/components/ui/brand';
import type { LeagueContext } from '@/lib/leagues/active-league';

/**
 * Authenticated application shell.
 *
 * ── WHAT THIS USED TO BE ───────────────────────────────────────────────────
 *
 * A header carrying the brand, the inbox link, the user's name, a sign-out
 * button, an "Active league" caption, a league `<select>`, a Switch button and
 * seven underlined navigation links — roughly 180px of chrome above every
 * screen on a 320px phone, and the reason the product read as a web page
 * rather than an app.
 *
 * ── WHAT IT IS NOW ─────────────────────────────────────────────────────────
 *
 *   * a **56px sticky app bar**: brand, then the avatar as the route to the
 *     profile. Nothing else;
 *   * a **league strip** directly under it when there is an active league —
 *     which league you are looking at is the most consequential fact on a
 *     multi-tenant screen, and it was previously an 11px grey caption;
 *   * a **bottom tab bar** with the four routes people move between.
 *
 * The switcher itself moved to the dashboard. It is a rare action that was
 * taking permanent space on every screen, and the dashboard is where somebody
 * already goes to decide what they are doing.
 *
 * Navigation is presentation, not authorization — every target re-checks
 * server-side, so a link that should not be there would still refuse.
 */
export function AppShell({
  displayName,
  avatarSrc,
  avatarInitials,
  leagueContext,
  unreadNotifications,
  children,
}: {
  displayName: string;
  /**
   * The signed-in user's own avatar, already resolved.
   *
   * `Avatar` directly rather than `PlayerAvatar`, because this is the **self**
   * flow: it is the one place a legacy `profile_photo_url` still renders, and
   * `PlayerAvatar` deliberately cannot express one. Resolved by
   * `avatarImageUrl` in the layout, which owns that priority order.
   */
  avatarSrc: string | null;
  avatarInitials: string;
  leagueContext: LeagueContext;
  unreadNotifications: number;
  children: ReactNode;
}) {
  const activeLeague = leagueContext.active;
  const isAdmin = activeLeague?.membership.role === 'league_admin';

  const tabs: NavTab[] = [
    { href: '/dashboard', label: 'Home', icon: 'home' },
    // Points at the active league when there is one. Without a league there is
    // no match list to show, so the same slot becomes the way to find one —
    // relabelled, because a tab called "Matches" that opens a search page is a
    // small lie repeated on every screen.
    activeLeague === null
      ? { href: '/leagues/discover', label: 'Leagues', icon: 'ball' }
      : { href: `/leagues/${activeLeague.league.slug}/matches`, label: 'Matches', icon: 'ball' },
    { href: '/notifications', label: 'Inbox', icon: 'bell', count: unreadNotifications },
    { href: '/profile', label: 'Profile', icon: 'user' },
  ];

  return (
    // `lg:max-w-3xl` rather than a second layout: MatchDay is a phone product
    // and a centred reading column is the right shape for it, but at 1280px the
    // 672px column left the roster workspace looking marooned. 768px is enough
    // for a member row's controls to sit comfortably beside the name without
    // the page becoming a desktop app nobody asked for.
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col lg:max-w-3xl">
      {/* Sticky and translucent: content sliding under it reads as depth, and
          the blur keeps the brand legible over whatever is passing beneath. */}
      <header className="sticky top-0 z-30 border-b border-[var(--border-subtle)] bg-[color-mix(in_oklab,var(--surface)_86%,transparent)] backdrop-blur-xl">
        {/* Still 56px at every width. The desktop navigation slots into the
            space the bar already had rather than making it taller — a header
            that grows to hold its own links is the other way this change goes
            wrong. */}
        <div className="flex h-14 items-center justify-between gap-3 px-4">
          <Link href="/dashboard" className="press flex min-w-0 items-center rounded-[var(--radius-md)]">
            <BrandLockup />
          </Link>

          <div className="flex shrink-0 items-center gap-2">
            {/* `lg` and up only; the tab bar owns navigation below that. */}
            <HeaderNav tabs={tabs} />

            <Link
              href="/profile"
              aria-label={`Your profile, ${displayName}`}
              className="press flex shrink-0 items-center rounded-full"
            >
              <Avatar src={avatarSrc} initials={avatarInitials} label={displayName} size={32} />
            </Link>
          </div>
        </div>

        {activeLeague === null ? null : (
          <LeagueStrip name={activeLeague.league.name} isAdmin={isAdmin} />
        )}
      </header>

      {/*
        Clearing the fixed tab bar is the footer's job, not this element's.
        Both used to carry `pb-28`, and measuring eight screens at 390px showed
        the result: the last control on every page stopped 184px above the bar,
        with about 240px of nothing under it. Two elements were each solving the
        whole problem.

        So `main` keeps ordinary spacing before the footer, and the footer below
        carries the clearance for both — see its comment for the arithmetic.
      */}
      <main id="main" className="flex flex-1 flex-col gap-6 px-4 pb-8 pt-5 lg:pb-12">
        {children}
      </main>

      {/* The one always-present route to a human. Quiet by design — small,
          muted, above the tab bar — but on every authenticated page, because
          the person who needs it is by definition somebody the product has
          already failed. Renders nothing at all when no support address is
          configured.

          The `<footer>` itself is unconditional, so its `pb-24` is what keeps
          the page clear of the tab bar: 96px against a bar of 56px plus the
          home indicator, which still leaves a comfortable margin on a device
          with the largest inset. From `lg` the bar is gone entirely. */}
      <footer className="px-4 pb-24 text-xs text-muted lg:pb-10">
        <SupportContact />
      </footer>

      <BottomNav tabs={tabs} />
    </div>
  );
}

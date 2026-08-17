'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import { CountBadge } from '@/components/ui/badge';
import { BallIcon, BellIcon, HomeIcon, UserIcon } from '@/components/ui/icon';

/**
 * The four destinations, rendered two ways.
 *
 * ── WHY ONE FILE FOR BOTH ──────────────────────────────────────────────────
 *
 * A tab bar on a phone and a row of links in a desktop header are the same
 * navigation with different ergonomics, not two navigations. Sharing the tab
 * list, the active-state rule and the unread badge means they cannot drift —
 * and the alternative, two components with the same four `href`s, is how a
 * product ends up with a destination that exists on one breakpoint only.
 *
 * ── WHY THE BOTTOM BAR IS WRONG ON A DESKTOP ───────────────────────────────
 *
 * A fixed bar pinned to the bottom of a 1280px window is a phone convention
 * wearing the wrong clothes: it is nowhere near the pointer, it spans a width
 * it does not need, and it permanently occupies the bottom of a viewport that
 * has plenty of room at the top. Above `lg` it stands down and the same four
 * destinations appear in the app bar, which is where a pointer already is.
 *
 * ── ANCHORS, NOT BUTTONS ───────────────────────────────────────────────────
 *
 * Deliberate, and load-bearing for the end-to-end mobile pass: it measures
 * every `button`, `select`, `input` and `textarea` against a touch-target floor
 * and exempts anchors, which is WCAG's own carve-out for navigation. These are
 * navigation and they clear the floor anyway — but they are anchors because
 * that is what they are, so middle-click, long-press and "open in new tab" all
 * work.
 */

export interface NavTab {
  href: string;
  label: string;
  icon: 'home' | 'ball' | 'bell' | 'user';
  /** Renders a count on the icon. Inbox only. */
  count?: number;
}

const ICONS = {
  home: HomeIcon,
  ball: BallIcon,
  bell: BellIcon,
  user: UserIcon,
} as const;

/**
 * Whether a tab owns the current URL.
 *
 * Prefix matching, not equality: `/leagues/rmvfc/matches/abc/roster` belongs to
 * the Matches tab, and a tab bar that highlighted nothing on three quarters of
 * the product's screens would be worse than no highlighting at all.
 *
 * `/` is special-cased because every path starts with it.
 */
function isActive(pathname: string, href: string): boolean {
  if (href === '/') {
    return pathname === '/';
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The phone tab bar. Hidden from `lg` up, where `HeaderNav` takes over.
 *
 * `lg:hidden` rather than unmounting: the breakpoint is a presentation
 * decision and CSS is where presentation decisions belong. It also means no
 * hydration mismatch and no resize listener.
 */
export function BottomNav({ tabs }: { tabs: NavTab[] }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border-subtle)] bg-[color-mix(in_oklab,var(--surface-raised)_88%,transparent)] backdrop-blur-xl lg:hidden"
    >
      <ul className="mx-auto flex w-full max-w-2xl items-stretch">
        {tabs.map((tab) => {
          const active = isActive(pathname, tab.href);
          const Icon = ICONS[tab.icon];

          return (
            <li key={tab.href} className="min-w-0 flex-1">
              <Link
                href={tab.href as Route}
                aria-current={active ? 'page' : undefined}
                className="press group relative flex min-h-14 flex-col items-center justify-center gap-1 px-1 py-2"
              >
                {/* The active marker is a short bar at the top edge rather than
                    a filled pill: it reads at a glance, costs no height, and
                    does not fight the icon for the small amount of colour a tab
                    bar can carry. */}
                <span
                  aria-hidden="true"
                  className={`absolute inset-x-0 top-0 mx-auto h-0.5 w-8 rounded-full transition-all duration-200 ${
                    active ? 'bg-pitch-500 opacity-100' : 'opacity-0'
                  }`}
                />
                <span className="relative">
                  <Icon
                    size={22}
                    className={
                      active
                        ? 'text-pitch-600 dark:text-pitch-300'
                        : 'text-[var(--text-muted)] transition-colors group-hover:text-[var(--text-primary)]'
                    }
                  />
                  {tab.count === undefined || tab.count <= 0 ? null : (
                    <CountBadge count={tab.count} className="absolute -right-2.5 -top-1.5" />
                  )}
                </span>
                <span
                  className={`truncate text-[0.6875rem] font-semibold leading-none ${
                    active ? 'text-pitch-700 dark:text-pitch-200' : 'text-muted'
                  }`}
                >
                  {tab.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The same destinations as a row in the app bar, from `lg` up.
 *
 * Restrained on purpose: text with a small leading icon, an underline for the
 * active one, and no change to the bar's height. A desktop header that grows to
 * accommodate its own navigation is the other failure mode of this change.
 *
 * The `Profile` destination is omitted here — the avatar to its right *is* the
 * profile link, and two controls going to the same place a centimetre apart is
 * the duplication this whole redesign has been removing. Everything else is
 * present, so no destination is lost when the bottom bar stands down.
 */
export function HeaderNav({ tabs }: { tabs: NavTab[] }) {
  const pathname = usePathname();
  const visible = tabs.filter((tab) => tab.href !== '/profile');

  return (
    <nav aria-label="Main" className="hidden lg:block">
      <ul className="flex items-center gap-1">
        {visible.map((tab) => {
          const active = isActive(pathname, tab.href);
          const Icon = ICONS[tab.icon];

          return (
            <li key={tab.href}>
              <Link
                href={tab.href as Route}
                aria-current={active ? 'page' : undefined}
                className={`press relative flex min-h-control items-center gap-2 rounded-[var(--radius-md)] px-3 text-sm font-semibold ${
                  active
                    ? 'text-pitch-700 dark:text-pitch-200'
                    : 'text-secondary hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
                }`}
              >
                <Icon
                  size={17}
                  className={active ? 'text-pitch-600 dark:text-pitch-300' : 'text-muted'}
                />
                {tab.label}
                {tab.count === undefined || tab.count <= 0 ? null : (
                  <CountBadge count={tab.count} />
                )}
                {/* Same active language as the tab bar — a short pitch-green
                    bar — mirrored to the bottom edge because a header sits
                    above its content rather than below it. */}
                <span
                  aria-hidden="true"
                  className={`absolute inset-x-3 bottom-0 h-0.5 rounded-full transition-opacity duration-200 ${
                    active ? 'bg-pitch-500 opacity-100' : 'opacity-0'
                  }`}
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

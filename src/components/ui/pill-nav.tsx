'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';

/**
 * A horizontal row of pill links, for navigating within a section.
 *
 * ── WHERE IT IS USED ───────────────────────────────────────────────────────
 *
 * League screens. Guidelines, Members, Settings and Templates are peers of each
 * other and children of a league; they were previously four underlined text
 * links in the global header, visible on every screen in the product including
 * the ones where they meant nothing.
 *
 * ── WHY IT SCROLLS ─────────────────────────────────────────────────────────
 *
 * Four pills do not fit across 320px, and the alternatives are worse: wrapping
 * turns a navigation row into a two-line block that shifts the page down, and
 * shrinking the text below 14px puts it under the legibility floor. A row that
 * scrolls sideways is a pattern people already know from every app on the
 * phone. `scrollbar-width: none` because a visible scrollbar under four pills
 * looks like a bug; the overflow is discoverable by dragging, which is how
 * anybody would try it.
 *
 * The negative margin plus matching padding lets the row bleed to the screen
 * edge while its first and last pill still align with the content beside it.
 */
export function PillNav({
  items,
  label,
}: {
  items: { href: string; label: string }[];
  /** Names the navigation landmark, e.g. "League". */
  label: string;
}) {
  const pathname = usePathname();

  if (items.length === 0) {
    return null;
  }

  return (
    <nav aria-label={label} className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none]">
      <ul className="flex w-max items-center gap-2 pb-0.5">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);

          return (
            <li key={item.href}>
              <Link
                href={item.href as Route}
                aria-current={active ? 'page' : undefined}
                className={`press inline-flex min-h-9 items-center rounded-full border px-3.5 py-1.5 text-sm font-semibold ${
                  active
                    ? 'border-pitch-600 bg-pitch-600 text-white dark:border-pitch-500 dark:bg-pitch-500 dark:text-pitch-950'
                    : 'border-[var(--border-subtle)] bg-[var(--surface-raised)] text-secondary hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]'
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

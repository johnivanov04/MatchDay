import type { ReactNode } from 'react';

/**
 * Containers, and the hierarchy between them.
 *
 * ── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────
 *
 * `surface-card p-4` appeared about forty times, so a hero panel summarising a
 * league and a single row in a list of devices were the same object: same
 * radius, same border, same flat white. Nothing on any screen claimed to matter
 * more than anything else, which is most of what "feels unpolished" turns out
 * to mean when you take a screen apart.
 *
 * Three levels now, and the choice between them is a design decision rather
 * than a copy-paste:
 *
 *   * `Panel`   — the subject of the screen. One per view, softly elevated.
 *   * `Card`    — an item in a collection: a match, a member, a device.
 *   * `Section` — a labelled group of content that is not itself an object.
 */

export function Section({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title?: string;
  description?: string;
  /** A link or button belonging to the group, right-aligned with the title. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex flex-col gap-3 ${className}`}>
      {title === undefined ? null : (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-[0.9375rem] font-semibold">{title}</h2>
            {description === undefined ? null : (
              <p className="text-sm text-muted">{description}</p>
            )}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Card({
  children,
  className = '',
  as: As = 'div',
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'li' | 'article';
  /** Adds hover lift. Only for a card that is entirely a link or a button. */
  interactive?: boolean;
}) {
  return (
    <As
      className={`surface-card ${
        interactive
          ? 'press hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-raised)]'
          : ''
      } ${className}`}
    >
      {children}
    </As>
  );
}

/**
 * The screen's subject.
 *
 * Carries the mown-grass striping, which is the one place the soccer theme
 * shows up on an ordinary screen — at around 3% alpha, so it registers as
 * "this surface has texture" rather than as a pattern anybody would describe.
 */
export function Panel({
  children,
  className = '',
  motif = true,
}: {
  children: ReactNode;
  className?: string;
  motif?: boolean;
}) {
  return (
    <section className={`surface-panel ${motif ? 'turf-stripes' : ''} overflow-hidden ${className}`}>
      {children}
    </section>
  );
}

/**
 * A row inside a card, with the hairline between rows handled once.
 *
 * `divide-hairline` on the parent rather than a border on each child, so the
 * last row never has a stray line under it and nobody has to remember
 * `last:border-b-0`.
 */
export function CardList({
  children,
  className = '',
  as: As = 'ul',
}: {
  children: ReactNode;
  className?: string;
  as?: 'ul' | 'ol' | 'div';
}) {
  return <As className={`divide-hairline flex flex-col ${className}`}>{children}</As>;
}

/**
 * A key/value pair, sized so a column of them lines up.
 *
 * `tabular` on the value: capacity, minimum players and squad counts sit in a
 * grid on the dashboard and on every match card, and proportional digits make
 * a two-column grid of numbers look accidentally ragged.
 */
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[0.6875rem] font-medium uppercase tracking-[0.07em] text-muted">
        {label}
      </dt>
      <dd className="tabular text-sm font-semibold">{value}</dd>
      {hint === undefined ? null : <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** The grid those stats sit in. Two columns on a phone, four when there is room. */
export function StatGrid({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <dl className={`grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 ${className}`}>{children}</dl>;
}

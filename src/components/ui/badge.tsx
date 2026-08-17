import type { ReactNode } from 'react';

/**
 * Status, as a shape rather than as a sentence.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 *
 * The product is full of state — a match is open or drafted or cancelled, a
 * membership is active or pending or suspended, a signup is confirmed or
 * waitlisted, an attendance outcome is one of five. Nearly all of it was
 * rendered as `capitalize` text in the same size and weight as everything
 * around it, so scanning a member list meant reading it.
 *
 * ── COLOUR IS NEVER THE ONLY SIGNAL ────────────────────────────────────────
 *
 * Every badge shows its label. The tone is a second, faster channel for people
 * who can use it, not a replacement for the first — which is both WCAG 1.4.1
 * and the only thing that works on a bright touchline.
 *
 * Tones map to meaning, not to decoration: `live` is confirmed and good,
 * `pending` needs a person, `off` is refused or gone, `info` is neutral, and
 * `neutral` is a label that is not a status at all.
 */

export type BadgeTone = 'neutral' | 'live' | 'pending' | 'off' | 'info';

const TONES: Record<BadgeTone, string> = {
  neutral:
    'border-[var(--border-subtle)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]',
  live: 'border-pitch-200 bg-pitch-50 text-pitch-800 dark:border-pitch-800 dark:bg-pitch-900/40 dark:text-pitch-200',
  pending:
    'border-flag-200 bg-flag-50 text-flag-700 dark:border-flag-900 dark:bg-flag-900/30 dark:text-flag-200',
  off: 'border-whistle-200 bg-whistle-50 text-whistle-700 dark:border-whistle-900 dark:bg-whistle-900/30 dark:text-whistle-200',
  info: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-900/30 dark:text-sky-200',
};

const DOTS: Record<BadgeTone, string> = {
  neutral: 'bg-night-400',
  live: 'bg-pitch-500',
  pending: 'bg-flag-500',
  off: 'bg-whistle-500',
  info: 'bg-sky-500',
};

export function Badge({
  tone = 'neutral',
  dot = false,
  icon,
  children,
  className = '',
}: {
  tone?: BadgeTone;
  /** A filled dot before the label. Reads as "state" rather than "category". */
  dot?: boolean;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${TONES[tone]} ${className}`}
    >
      {dot ? (
        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${DOTS[tone]}`} />
      ) : null}
      {icon}
      {children}
    </span>
  );
}

/**
 * A count that sits on top of something, like the inbox tab.
 *
 * Caps at 99+ so a neglected inbox cannot widen the thing it is attached to.
 */
export function CountBadge({ count, className = '' }: { count: number; className?: string }) {
  if (count <= 0) {
    return null;
  }

  return (
    <span
      aria-hidden="true"
      className={`tabular inline-flex min-w-[1.125rem] items-center justify-center rounded-full bg-whistle-500 px-1 py-0.5 text-[0.625rem] font-bold leading-none text-white ${className}`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

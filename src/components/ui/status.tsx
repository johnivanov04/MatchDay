import type { ReactNode } from 'react';

/**
 * The three states every screen has and none of them had.
 *
 * Loading, empty and error were being written inline where anybody remembered
 * them, which is why a slow query showed a blank page, an empty list showed
 * nothing at all, and a failed render showed the Next.js error overlay. These
 * are one shape so the answer is the same everywhere, and so the accessibility
 * details — the live region, the heading level, the focus target — are decided
 * once rather than per screen.
 */

/**
 * A placeholder with the shape of the content it is standing in for.
 *
 * `aria-hidden`, because a screen reader user is told the page is loading by
 * the live region in `LoadingState`; announcing a dozen grey rectangles as well
 * would be noise. `motion-reduce:animate-none` because a pulsing block is
 * exactly the kind of movement that triggers vestibular symptoms, and the
 * placeholder still reads as a placeholder when it is still.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-lg bg-[var(--border-subtle)] motion-reduce:animate-none ${className}`}
    />
  );
}

/**
 * What a route shows while its server component is still running.
 *
 * `role="status"` with the default `aria-live="polite"`: the message is
 * announced when the reader finishes its current sentence rather than
 * interrupting, which is right for "this is coming" and wrong for an error.
 */
export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex flex-col gap-3">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-7 w-1/2" />
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

/**
 * A list or section with nothing in it.
 *
 * Takes an explanation rather than only a title, because "No matches" leaves
 * somebody wondering whether the app is broken or the league is quiet, and only
 * one of those is worth their attention.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="surface-card flex flex-col items-start gap-2 p-6">
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-sm text-muted">{description}</p>
      {action}
    </div>
  );
}

/**
 * Something failed.
 *
 * `role="alert"` — assertive, unlike the loading state: the reader should be
 * interrupted, because whatever they were about to do is not going to work.
 *
 * The message is ours, never the thrown error's. A rendering failure can carry
 * a database constraint name, a column value or an identifier belonging to
 * another tenant, and `error.message` is the shortest path from any of those to
 * somebody's screen.
 */
export function ErrorState({
  title = 'Something went wrong',
  description = 'That did not work. Try again, and if it keeps happening tell your league administrator.',
  action,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-lg border border-red-300 bg-red-50 p-6 text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-100"
    >
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-sm">{description}</p>
      {action}
    </div>
  );
}

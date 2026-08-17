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
 * would be noise. The shimmer is an opacity cycle rather than a sweeping
 * gradient: it costs no repaint of a moving element, and at 55–85% it reads as
 * "working" without the strobing that a full-contrast pulse produces.
 * `motion-reduce:animate-none` because even that is movement somebody may have
 * asked not to see, and a still placeholder still reads as a placeholder.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-shimmer rounded-[var(--radius-md)] bg-[var(--surface-sunken)] motion-reduce:animate-none ${className}`}
    />
  );
}

/**
 * What a route shows while its server component is still running.
 *
 * `role="status"` with the default `aria-live="polite"`: the message is
 * announced when the reader finishes its current sentence rather than
 * interrupting, which is right for "this is coming" and wrong for an error.
 *
 * The shape mirrors a real screen — an eyebrow, a title, then cards — so the
 * layout does not jump when the content lands.
 */
export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex flex-col gap-6">
      <span className="sr-only">{label}</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full opacity-60" />
      </div>
    </div>
  );
}

/**
 * A list or section with nothing in it.
 *
 * ── AN EMPTY STATE IS A SCREEN, NOT AN APOLOGY ─────────────────────────────
 *
 * These used to be `<p class="text-sm text-muted">No upcoming matches yet.</p>`
 * — which leaves somebody wondering whether the app is broken or the league is
 * quiet, and only one of those deserves their attention. Every one now carries
 * three things: an icon so the space reads as designed, a sentence that says
 * which of those two it is, and — where there is one — the action that would
 * fix it.
 *
 * The chalk arc bleeding off the top-right corner is the same centre-circle
 * motif used on the sign-in screen. It is the one moment in the product where
 * there is room for the theme to be visible, so it is slightly stronger here
 * than anywhere else.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="chalk-arc surface-card animate-rise flex flex-col items-start gap-3 p-6">
      {icon === undefined ? null : (
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-pitch-50 text-pitch-600 dark:bg-pitch-900/50 dark:text-pitch-300">
          {icon}
        </span>
      )}
      <div className="flex flex-col gap-1">
        <p className="text-[0.9375rem] font-semibold">{title}</p>
        <p className="max-w-prose text-sm leading-relaxed text-secondary">{description}</p>
      </div>
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
      className="animate-rise flex flex-col items-start gap-3 rounded-[var(--radius-lg)] border border-whistle-200 bg-whistle-50 p-6 text-whistle-900 dark:border-whistle-900 dark:bg-whistle-900/25 dark:text-whistle-100"
    >
      <p className="text-[0.9375rem] font-semibold">{title}</p>
      <p className="max-w-prose text-sm leading-relaxed">{description}</p>
      {action}
    </div>
  );
}

/**
 * An inline notice: a result, a caveat, a heads-up.
 *
 * Replaces a scattering of one-off `<p class="rounded-lg border …">` blocks
 * that each picked their own colour. `tone` decides the colour; `role` decides
 * whether a screen reader is interrupted, and defaults to the polite one.
 */
export function Notice({
  tone = 'info',
  role = 'status',
  icon,
  children,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  role?: 'status' | 'alert';
  icon?: ReactNode;
  children: ReactNode;
}) {
  const tones = {
    info: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-900/25 dark:text-sky-100',
    success:
      'border-pitch-200 bg-pitch-50 text-pitch-900 dark:border-pitch-800 dark:bg-pitch-900/35 dark:text-pitch-50',
    warning:
      'border-flag-200 bg-flag-50 text-flag-900 dark:border-flag-900 dark:bg-flag-900/25 dark:text-flag-100',
    danger:
      'border-whistle-200 bg-whistle-50 text-whistle-900 dark:border-whistle-900 dark:bg-whistle-900/25 dark:text-whistle-100',
  } as const;

  return (
    <p
      role={role}
      // No fade: a notice is text, and text mid-fade is text at reduced
      // contrast. See the note on `@keyframes rise` in globals.css.
      className={`animate-rise flex items-start gap-2.5 rounded-[var(--radius-md)] border px-3.5 py-3 text-sm leading-relaxed ${tones[tone]}`}
    >
      {icon}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

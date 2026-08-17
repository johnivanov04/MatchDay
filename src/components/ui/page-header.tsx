import type { ReactNode } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { ArrowLeftIcon } from '@/components/ui/icon';

/**
 * The top of every screen.
 *
 * ── WHAT IT REPLACES ───────────────────────────────────────────────────────
 *
 * Eleven hand-built headers, most of them:
 *
 *     <p class="text-xs uppercase text-muted">{league.name}</p>
 *     <h1 class="text-2xl font-bold">Matches</h1>
 *     <Link class="text-sm underline">Create a match</Link>
 *
 * Three problems in three lines. The eyebrow was the same weight as a caption,
 * so which league you were in — the single most consequential fact on a
 * multi-tenant screen — was the least visible thing on it. The title had no
 * relationship to it. And the primary action of the screen was an underlined
 * text link, indistinguishable from a footnote.
 *
 * ── THE STRUCTURE ──────────────────────────────────────────────────────────
 *
 *   eyebrow (league or context) · title · description · actions
 *
 * `actions` is a slot rather than a prop of link shapes, because screens differ
 * — one has a single primary button, another has two, another has a filter. A
 * slot keeps the layout decision here and the content decision there.
 */

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  back,
  icon,
}: {
  /** Where you are: usually the league name. Rendered above the title. */
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  /** Buttons for this screen. Wraps on a phone. */
  actions?: ReactNode;
  /** A way back, for screens reached from a parent rather than from a tab. */
  back?: { href: Route | string; label: string };
  icon?: ReactNode;
}) {
  return (
    <header className="animate-rise flex flex-col gap-3">
      {back === undefined ? null : (
        <Link
          href={back.href as Route}
          className="press -ml-1 inline-flex min-h-control w-fit items-center gap-1.5 rounded-[var(--radius-md)] px-1 text-sm font-medium text-muted hover:text-[var(--text-primary)]"
        >
          <ArrowLeftIcon size={16} />
          {back.label}
        </Link>
      )}

      <div className="flex flex-col gap-1.5">
        {eyebrow === undefined ? null : (
          <p className="flex items-center gap-1.5 text-[0.6875rem] font-bold uppercase tracking-[0.09em] text-pitch-700 dark:text-pitch-300">
            {icon}
            <span className="min-w-0 truncate">{eyebrow}</span>
          </p>
        )}
        <h1 className="text-[1.75rem] font-bold leading-[1.15]">{title}</h1>
        {description === undefined ? null : (
          <p className="max-w-prose text-sm leading-relaxed text-secondary">{description}</p>
        )}
      </div>

      {actions === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

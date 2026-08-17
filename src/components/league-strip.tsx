'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { ChevronRightIcon, ShieldIcon } from '@/components/ui/icon';

/**
 * The active-league strip under the app bar.
 *
 * ── WHY IT HIDES ITSELF ON LEAGUE ROUTES ───────────────────────────────────
 *
 * Every league-scoped page already names its league in the page header's
 * eyebrow, because that is the league the *page* is about. This strip names the
 * league that is *active*. On `/dashboard` and `/profile` those are the same
 * useful fact stated once; on `/leagues/…` they are two league names stacked
 * fifty pixels apart — and, worse, they can be **different** leagues, since you
 * can open a link to league A while league B is active. The screenshot review
 * caught exactly that: "ACTIVE LEAGUE / E2E League 1ac6…" directly above
 * "E2E LEAGUE 5F24…".
 *
 * So the strip stands down wherever a page header is already carrying league
 * context, and the page header wins because it describes what you are looking
 * at rather than what you last selected.
 */
export function LeagueStrip({
  name,
  isAdmin,
}: {
  name: string;
  isAdmin: boolean;
}) {
  const pathname = usePathname();

  // Every league-scoped route renders a PageHeader with an eyebrow naming its
  // own league. `/leagues/discover` and `/leagues/new` do not belong to a
  // league at all, so the strip is still useful there.
  const pageOwnsLeagueContext =
    pathname.startsWith('/leagues/') &&
    !pathname.startsWith('/leagues/discover') &&
    !pathname.startsWith('/leagues/new');

  if (pageOwnsLeagueContext) {
    return null;
  }

  return (
    <Link
      href="/dashboard"
      className="press turf-stripes flex items-center gap-2.5 border-t border-[var(--border-subtle)] px-4 py-2.5 hover:bg-[var(--surface-hover)]"
    >
      <span
        aria-hidden="true"
        className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] bg-pitch-600 text-white dark:bg-pitch-500 dark:text-pitch-950"
      >
        <ShieldIcon size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[0.625rem] font-bold uppercase tracking-[0.09em] text-muted">
          Active league
        </span>
        <span className="min-w-0 truncate text-sm font-semibold leading-tight">{name}</span>
      </span>
      {isAdmin ? <Badge tone="live">Admin</Badge> : null}
      <ChevronRightIcon size={16} className="text-muted" />
    </Link>
  );
}

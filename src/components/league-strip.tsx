'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { LeagueMenu, type LeagueMenuEntry } from '@/components/league-menu';
import { Badge } from '@/components/ui/badge';
import { ChevronRightIcon, ShieldIcon } from '@/components/ui/icon';

/**
 * The active-league strip under the app bar, and the control it opens.
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
 *
 * ── WHY IT IS A BUTTON NOW ─────────────────────────────────────────────────
 *
 * It was a `<Link href="/dashboard">` — chevron, hover state, the full width
 * tappable, and on the dashboard itself a link to the page you were already on.
 * It looked like a control and behaved like nothing. It is now what it always
 * looked like: the way into the league menu, which is where switching, the
 * other memberships and the league-level destinations live.
 */
export function LeagueStrip({
  name,
  isAdmin,
  activeLeagueId,
  entries,
}: {
  name: string;
  isAdmin: boolean;
  activeLeagueId: string;
  entries: LeagueMenuEntry[];
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  /**
   * Open the sheet.
   *
   * ── WHY THIS TOUCHES THE ELEMENT AND NOT ONLY THE STATE ────────────────────
   *
   * The browser owns a `<dialog>`'s real state. Escape closes it without asking
   * React, and the `close` event that tells React about it is processed on
   * React's schedule — so there is a window in which the sheet is shut and
   * `open` is still `true`. Pressing the strip in that window would call
   * `setOpen(true)` with `true` already stored: not a state change, so no
   * re-render, so no effect, so the sheet never reopens. It is a small window,
   * and the end-to-end suite walked straight into it by pressing Escape and
   * Enter as fast as a machine can.
   *
   * Asking the element whether it is open removes the disagreement rather than
   * narrowing it. Either ordering of the two updates settles on `true`, and the
   * effect in `LeagueMenu` finds the DOM already in the state it wanted.
   */
  const openMenu = useCallback(() => {
    setOpen(true);
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  // Focus goes back where it came from on every dismissal. The browser does
  // this for `<dialog>` in most cases already; doing it explicitly means it
  // does not depend on which case.
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // A link inside the sheet has taken us somewhere. Closing on the route change
  // rather than on each link's click covers the back button too, and does not
  // pull focus — the new page owns that.
  //
  // Adjusted during render rather than in an effect, which is React's own
  // guidance for "reset state when something changes": an effect would paint
  // the sheet over the new page first and then immediately paint again to
  // remove it.
  const [renderedPath, setRenderedPath] = useState(pathname);
  if (renderedPath !== pathname) {
    setRenderedPath(pathname);
    setOpen(false);
  }

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
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openMenu}
        aria-haspopup="dialog"
        aria-expanded={open}
        // The strip reads as one object, so it is one control with one name
        // rather than a row of pieces. The league is in the name because
        // "Change league" alone would not say which one you are in.
        aria-label={`Active league: ${name}. Change league`}
        className="press turf-stripes flex min-h-control w-full items-center gap-2.5 border-t border-[var(--border-subtle)] px-4 py-2.5 text-left hover:bg-[var(--surface-hover)]"
      >
        <span
          aria-hidden="true"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-pitch-600 text-white dark:bg-pitch-500 dark:text-pitch-950"
        >
          <ShieldIcon size={15} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[0.625rem] font-bold uppercase tracking-[0.09em] text-muted">
            Active league
          </span>
          <span className="min-w-0 truncate text-sm font-semibold leading-tight">{name}</span>
        </span>
        {isAdmin ? (
          <Badge tone="live" className="shrink-0">
            Admin
          </Badge>
        ) : null}
        <ChevronRightIcon size={16} className="shrink-0 text-muted" />
      </button>

      <LeagueMenu
        open={open}
        onClose={close}
        dialogRef={dialogRef}
        activeLeagueId={activeLeagueId}
        entries={entries}
      />
    </>
  );
}

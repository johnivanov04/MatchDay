'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useEffect, useRef, type MouseEvent, type RefObject } from 'react';
import { useActionState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/field';
import { CheckIcon, PlusIcon, SearchIcon, SettingsIcon, ShieldIcon } from '@/components/ui/icon';
import { switchActiveLeagueAction } from '@/server/actions/active-league';

/**
 * The league menu: everything about "which league am I in", in one sheet.
 *
 * ── WHAT IT REPLACED ───────────────────────────────────────────────────────
 *
 * The active-league strip looked like a control — chevron, hover state, the
 * whole width tappable — and was a `<Link href="/dashboard">`. On the dashboard,
 * which is the screen it is most visible on, tapping it navigated to the page
 * you were already on: a control that visibly did nothing. Switching leagues
 * actually lived in a `<select>` plus a Switch button further down that page.
 *
 * ── ONE SWITCHING IMPLEMENTATION, NOT TWO ──────────────────────────────────
 *
 * Every row here submits `switchActiveLeagueAction`, the same server action the
 * dashboard control used. Nothing about the rules moved into the client: the
 * action re-derives the user from the session, `setActiveLeague` refuses a
 * league the caller is not actively a member of, and a database trigger refuses
 * it again. A forged `league_id` from this sheet fails exactly where it failed
 * before.
 *
 * ── WHY ONE FORM AND MANY BUTTONS ──────────────────────────────────────────
 *
 * A submit button contributes its own `name`/`value` to the form data, so N
 * leagues need one `<form>`, one `useActionState` and N buttons — not N forms
 * each with their own pending state and their own copy of the error handling.
 */

export interface LeagueMenuEntry {
  id: string;
  name: string;
  slug: string;
  isAdmin: boolean;
  /** `pending` and `suspended` are shown but cannot be switched to (PRD §11). */
  status: 'active' | 'pending' | 'suspended';
}

const TITLE_ID = 'league-menu-title';

export function LeagueMenu({
  open,
  onClose,
  dialogRef,
  activeLeagueId,
  entries,
}: {
  open: boolean;
  /** Called for every dismissal — Escape, the backdrop, Done, a successful switch. */
  onClose: () => void;
  /**
   * Owned by the strip, because the strip is what opens it — and opening has to
   * be able to ask the element what it is actually doing. See `LeagueStrip`.
   */
  dialogRef: RefObject<HTMLDialogElement | null>;
  activeLeagueId: string;
  entries: LeagueMenuEntry[];
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [state, submit, pending] = useActionState(switchActiveLeagueAction, null);

  // `showModal()` rather than the `open` attribute: only the modal form gets
  // the focus trap, the inert background and the `::backdrop`. Opening is done
  // by the strip; this only has to catch up when `open` goes false.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, dialogRef]);

  // A switch re-renders the whole layout through `revalidatePath`, so the strip
  // behind the sheet is already showing the new league. Staying open would make
  // somebody dismiss a menu to see the thing they just did.
  useEffect(() => {
    if (state?.ok === true) {
      onClose();
    }
  }, [state, onClose]);

  const active = entries.filter((entry) => entry.status === 'active');
  const current = entries.find((entry) => entry.id === activeLeagueId);
  const others = active.filter((entry) => entry.id !== activeLeagueId);
  const inactive = entries.filter((entry) => entry.status !== 'active');

  /**
   * Dismiss on a click outside the panel.
   *
   * The dialog fills the viewport, so "the backdrop" is the part of it the
   * panel does not cover. Asking the panel whether it contains the target is
   * more robust than comparing against the dialog itself, which stops being
   * the event target the moment anything is layered over it.
   */
  const onDialogClick = (event: MouseEvent<HTMLDialogElement>) => {
    const panel = panelRef.current;
    if (panel !== null && !panel.contains(event.target as Node)) {
      onClose();
    }
  };

  /**
   * The element telling us it closed — which is not always news.
   *
   * HTML queues `close` as a *task* rather than dispatching it synchronously,
   * so a fast Escape-then-reopen delivers it after the sheet is already back
   * on screen, describing a state the element is no longer in. Acting on it
   * would shut a sheet somebody had just opened; the end-to-end suite hit this
   * on three or four of every twenty cycles.
   *
   * Asking the element what it is doing now, rather than trusting an event
   * about what it was doing then, is the whole fix.
   */
  const onDialogClose = () => {
    if (dialogRef.current?.open === true) {
      return;
    }
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={TITLE_ID}
      className="sheet-dialog"
      // Fires for Escape and for `close()` alike — but late, and sometimes
      // about the wrong moment entirely. See `onDialogClose`.
      onClose={onDialogClose}
      onClick={onDialogClick}
    >
      {/* Mounted only while open. A closed `<dialog>` is `display: none` and
          harmless to look at, but its contents are still real DOM — and this
          sheet holds a "Find a league" and a "Create a league" link that also
          exist on the dashboard. Two links with one accessible name on one page
          is a genuine ambiguity for anybody navigating by name. */}
      {open ? (
        <div className="flex h-full w-full flex-col justify-end sm:items-center sm:justify-start sm:pt-[6.5rem]">
          <div
            ref={panelRef}
            className="sheet-enter pb-safe flex max-h-[85dvh] w-full flex-col overflow-y-auto rounded-t-[1.5rem] border border-[var(--border-subtle)] bg-[var(--surface-raised)] shadow-[var(--shadow-float)] sm:max-w-sm sm:rounded-[var(--radius-lg)]"
          >
            {/* The grab handle. Purely a signal that this is a sheet and can be
                dismissed; phones have taught everybody to read it. Gone from
                `sm` up, where the panel is a popover and the handle would be
                a phone idiom on a desktop. */}
            <span
              aria-hidden="true"
              className="mx-auto mt-2.5 h-1 w-9 shrink-0 rounded-full bg-[var(--border-strong)] sm:hidden"
            />

            <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-3">
              <h2 id={TITLE_ID} className="text-[0.9375rem] font-semibold">
                Your leagues
              </h2>
              <Button variant="ghost" size="sm" onClick={onClose}>
                Done
              </Button>
            </div>

            <form action={submit} className="flex flex-col">
              <ul className="divide-hairline flex flex-col border-y border-[var(--border-subtle)]">
                {current === undefined ? null : (
                  <CurrentLeagueRow entry={current} />
                )}

                {others.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="submit"
                      name="league_id"
                      value={entry.id}
                      disabled={pending}
                      className="press flex min-h-control w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--surface-hover)] disabled:opacity-55"
                    >
                      <LeagueGlyph />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {entry.name}
                      </span>
                      {entry.isAdmin ? (
                        <Badge tone="neutral">Admin</Badge>
                      ) : (
                        <Badge tone="neutral">Player</Badge>
                      )}
                    </button>
                  </li>
                ))}

                {/* Visible, and deliberately not actionable: somebody needs to
                    see that they asked to join a league and are still waiting,
                    without the app implying they can work there. */}
                {inactive.map((entry) => (
                  <li key={entry.id} className="flex items-center gap-3 px-4 py-3">
                    <LeagueGlyph muted />
                    <span className="min-w-0 flex-1 truncate text-sm text-secondary">
                      {entry.name}
                    </span>
                    <Badge tone={entry.status === 'pending' ? 'pending' : 'off'} dot>
                      {entry.status === 'pending' ? 'Awaiting approval' : 'Suspended'}
                    </Badge>
                  </li>
                ))}
              </ul>

              {pending ? (
                <p role="status" className="flex items-center gap-2 px-4 py-2 text-sm text-muted">
                  <Spinner />
                  Switching league…
                </p>
              ) : null}

              {state?.ok === false ? (
                <p
                  role="alert"
                  className="px-4 py-2 text-sm font-medium text-whistle-600 dark:text-whistle-300"
                >
                  {state.message}
                </p>
              ) : null}
            </form>

            <div className="flex flex-col p-2 pb-3">
              {/* Administrator-only, and secondary to switching: this sheet is
                  about which league you are in, not about running one. The
                  route re-checks the role server-side regardless of what is
                  rendered here. */}
              {current?.isAdmin === true ? (
                <MenuLink
                  href={`/leagues/${current.slug}/settings`}
                  icon={<SettingsIcon size={17} />}
                  label="Manage league"
                />
              ) : null}
              <MenuLink
                href="/leagues/discover"
                icon={<SearchIcon size={17} />}
                label="Find a league"
              />
              <MenuLink href="/leagues/new" icon={<PlusIcon size={17} />} label="Create a league" />
            </div>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

/** The league you are in: named, badged, and marked as the current one. */
function CurrentLeagueRow({ entry }: { entry: LeagueMenuEntry }) {
  return (
    <li className="flex items-center gap-3 bg-pitch-50/70 px-4 py-3 dark:bg-pitch-900/25">
      <span
        aria-hidden="true"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-pitch-600 text-white dark:bg-pitch-500 dark:text-pitch-950"
      >
        <ShieldIcon size={16} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 truncate text-sm font-semibold">{entry.name}</span>
        {/* The state in words as well as in colour: "current" is the one fact
            this sheet exists to establish. */}
        <span className="text-xs text-muted">Current league</span>
      </span>
      <Badge tone="live">{entry.isAdmin ? 'Admin' : 'Player'}</Badge>
      <CheckIcon size={17} className="shrink-0 text-pitch-600 dark:text-pitch-300" />
    </li>
  );
}

function LeagueGlyph({ muted = false }: { muted?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] ${
        muted
          ? 'bg-[var(--surface-sunken)] text-muted'
          : 'bg-pitch-50 text-pitch-700 dark:bg-pitch-900/50 dark:text-pitch-300'
      }`}
    >
      <ShieldIcon size={16} />
    </span>
  );
}

/** A destination in the sheet's footer. An anchor, because it navigates. */
function MenuLink({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <Link
      href={href as Route}
      className="press flex min-h-control items-center gap-3 rounded-[var(--radius-md)] px-2 py-2.5 text-sm font-medium hover:bg-[var(--surface-hover)]"
    >
      <span aria-hidden="true" className="text-muted">
        {icon}
      </span>
      {label}
    </Link>
  );
}

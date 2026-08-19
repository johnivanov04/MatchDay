'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useCallback, useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { useActionState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/field';
import {
  CheckIcon,
  LogOutIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  UsersIcon,
} from '@/components/ui/icon';
import { switchActiveLeagueAction } from '@/server/actions/active-league';
import { leaveLeagueAction } from '@/server/actions/membership';

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
  /**
   * `pending`, `suspended` and `closed` are shown but cannot be switched to.
   *
   * `closed` is the odd one out: the membership is still active, and it is the
   * *league* that has ended. It appears so somebody can see where their history
   * went rather than watching a league silently vanish from the list.
   */
  status: 'active' | 'pending' | 'suspended' | 'closed';
}

const TITLE_ID = 'league-menu-title';
const CONFIRM_TITLE_ID = 'league-leave-title';
const CONFIRM_BODY_ID = 'league-leave-body';

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

  /**
   * The league somebody has asked to leave, and the sheet that asks whether
   * they meant it.
   *
   * ── A SIBLING `<dialog>`, NOT A NESTED ONE ────────────────────────────────
   *
   * The obvious place for a confirmation is inside the panel it was triggered
   * from. It is the wrong place twice over. The menu dismisses itself on any
   * click its panel does not contain — that is how backdrop-dismiss works here
   * — so a click on the confirmation's own backdrop would bubble out and shut
   * the entire menu instead of the confirmation. And the switcher is one
   * `<form>` spanning every league row, so a second form inside it would be
   * nested form elements, which HTML does not have.
   *
   * As a sibling, the two are independent: the confirmation's events never
   * reach the menu, the browser makes the menu inert while the confirmation is
   * modal, and Escape closes only the topmost. Cancelling therefore returns you
   * to the menu you were standing in rather than to the page.
   */
  const [leaving, setLeaving] = useState<LeagueMenuEntry | null>(null);
  const confirmRef = useRef<HTMLDialogElement>(null);
  const confirmPanelRef = useRef<HTMLDivElement>(null);
  const [leaveState, leave, leavePending] = useActionState(leaveLeagueAction, null);

  // Imperative, for the same reason `LeagueStrip` opens the menu imperatively:
  // the browser owns a dialog's real state, and a `close` event React has not
  // processed yet leaves the two disagreeing. Asking the element what it is
  // doing removes the disagreement rather than narrowing it.
  const askToLeave = useCallback((entry: LeagueMenuEntry) => {
    setLeaving(entry);
    const dialog = confirmRef.current;
    if (dialog !== null && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  const cancelLeave = useCallback(() => {
    setLeaving(null);
    const dialog = confirmRef.current;
    if (dialog !== null && dialog.open) {
      dialog.close();
    }
  }, []);

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

  // The confirmation cannot outlive the menu it belongs to. The menu closes on
  // a route change without anything here being clicked, and a confirmation
  // still floating over the next page would be asking about a decision whose
  // context has gone.
  //
  // Adjusted during render rather than in an effect — React's own guidance for
  // "reset state when something changes", and what `LeagueStrip` already does
  // for the same reason. The DOM half is below, because closing an element is
  // not something to do while rendering.
  const [renderedOpen, setRenderedOpen] = useState(open);
  if (renderedOpen !== open) {
    setRenderedOpen(open);
    if (!open) {
      setLeaving(null);
    }
  }

  // The backstop for every route out of the confirmation: Cancel closes the
  // element itself, but the menu closing, a stale `close` event and a route
  // change all clear `leaving` without touching the DOM.
  useEffect(() => {
    const dialog = confirmRef.current;
    if (leaving === null && dialog !== null && dialog.open) {
      dialog.close();
    }
  }, [leaving]);

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

  // The same two protections, on the confirmation. They are not decoration:
  // the reopen race is a property of `<dialog>`, not of this particular sheet,
  // and a confirmation is exactly where a stale `close` would do most harm.
  const onConfirmClick = (event: MouseEvent<HTMLDialogElement>) => {
    const panel = confirmPanelRef.current;
    if (panel !== null && !panel.contains(event.target as Node)) {
      cancelLeave();
    }
  };

  const onConfirmClose = () => {
    if (confirmRef.current?.open === true) {
      return;
    }
    setLeaving(null);
  };

  const menu = (
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
                      {entry.status === 'pending'
                        ? 'Awaiting approval'
                        : entry.status === 'closed'
                          ? 'Closed'
                          : 'Suspended'}
                    </Badge>
                    {/* A suspension stops somebody playing. It must not also
                        trap them: being told to sit out is a restriction, and
                        turning it into "and you may never leave" would make it
                        a punishment the product does not otherwise impose. So
                        the one row where leaving is not reachable by switching
                        to the league first carries its own way out.

                        `type="button"`, because this sits inside the switcher's
                        form and must not submit it. */}
                    {entry.status === 'suspended' ? (
                      <Button
                        type="button"
                        variant="quiet"
                        size="sm"
                        onClick={() => {
                          askToLeave(entry);
                        }}
                      >
                        Leave
                      </Button>
                    ) : null}
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

            {/* ── Leaving ────────────────────────────────────────────────────
                Below a rule and after the navigation, because it is not
                navigation: it is the one thing in this sheet that cannot be
                undone by tapping something else. Scoped to the league you are
                actually in — a leave control on every row would turn a
                switcher into a minefield, and switching first is one tap. */}
            {current === undefined ? null : (
              <div className="border-t border-[var(--border-subtle)] p-2 pb-3">
                {current.isAdmin ? (
                  <AdminCannotLeave slug={current.slug} />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      askToLeave(current);
                    }}
                    className="press flex min-h-control w-full items-center gap-3 rounded-[var(--radius-md)] px-2 py-2.5 text-left text-sm font-medium text-whistle-700 hover:bg-whistle-50 dark:text-whistle-300 dark:hover:bg-whistle-900/30"
                  >
                    <LogOutIcon size={17} />
                    Leave league
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </dialog>
  );

  return (
    <>
      {menu}

      <dialog
        ref={confirmRef}
        aria-labelledby={CONFIRM_TITLE_ID}
        aria-describedby={CONFIRM_BODY_ID}
        className="sheet-dialog"
        onClose={onConfirmClose}
        onClick={onConfirmClick}
      >
        {leaving === null ? null : (
          <div className="flex h-full w-full flex-col justify-end sm:items-center sm:justify-center">
            <div
              ref={confirmPanelRef}
              className="sheet-enter pb-safe flex w-full flex-col gap-3 rounded-t-[1.5rem] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-4 shadow-[var(--shadow-float)] sm:max-w-sm sm:rounded-[var(--radius-lg)]"
            >
              <h2 id={CONFIRM_TITLE_ID} className="text-base font-semibold">
                {/* The league is named in the heading rather than in the body,
                    because "Leave this league?" over a sheet that has just
                    covered the list is a question somebody cannot check. */}
                Leave {leaving.name}?
              </h2>
              <p id={CONFIRM_BODY_ID} className="text-sm text-secondary">
                You&rsquo;ll lose access to this league and its upcoming matches. Your past match
                and attendance history will not be deleted.
              </p>

              {leaveState?.ok === false ? (
                <p
                  role="alert"
                  className="text-sm font-medium text-whistle-600 dark:text-whistle-300"
                >
                  {leaveState.message}
                </p>
              ) : null}

              <form action={leave} className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                {/* The league id and nothing else. `leave_league()` resolves
                    which membership that means from the session, so there is no
                    membership id here to substitute — and a forged league id can
                    only name a league the caller does not belong to. */}
                <input type="hidden" name="league_id" value={leaving.id} />
                <Button type="button" variant="secondary" onClick={cancelLeave} disabled={leavePending}>
                  Cancel
                </Button>
                <Button type="submit" variant="danger" disabled={leavePending}>
                  {leavePending ? 'Leaving…' : 'Leave league'}
                </Button>
              </form>
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}

/**
 * What an administrator sees where the Leave control would be.
 *
 * Not a disabled button. A disabled control says "not now" and gives no way
 * forward; the administrator's problem has a specific solution, on a specific
 * page, and this is a link to it. The database refuses an administrator's
 * departure regardless of what is rendered here — that refusal is the control,
 * and this is the explanation.
 */
function AdminCannotLeave({ slug }: { slug: string }) {
  return (
    <Link
      href={`/leagues/${slug}/members` as Route}
      className="press flex min-h-control items-center gap-3 rounded-[var(--radius-md)] px-2 py-2.5 hover:bg-[var(--surface-hover)]"
    >
      <span aria-hidden="true" className="text-muted">
        <UsersIcon size={17} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium">Transfer administration before leaving</span>
        <span className="text-xs text-muted">A league always needs one administrator.</span>
      </span>
    </Link>
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

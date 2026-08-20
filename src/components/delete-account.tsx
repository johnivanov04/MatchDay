'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useActionState, useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, inputClassName, SubmitButton } from '@/components/ui/field';
import { AlertIcon, LogOutIcon, UsersIcon } from '@/components/ui/icon';
import { Notice } from '@/components/ui/status';
import {
  closeLeagueAction,
  deleteAccountAction,
  requestDeletionCodeAction,
} from '@/server/actions/account';
import type { AccountDeletionBlocker } from '@/types/database';

/**
 * Delete account, from the Profile screen.
 *
 * ── WHY THE BLOCKED CASE IS A DIFFERENT SCREEN, NOT A DISABLED BUTTON ──────
 *
 * A league has exactly one active administrator, so deleting the only one would
 * leave it with none. "You cannot do this" is a true thing to say and a useless
 * one; what this shows instead is the specific leagues in the way and the two
 * things that resolve each of them.
 *
 * ── AND WHY CLOSE IS OFFERED TO EVERY ADMINISTRATOR ────────────────────────
 *
 * `transfer_league_administration` needs an active player to hand over to. An
 * administrator whose league has no other member would otherwise be reading an
 * instruction they cannot follow — a screen with no way out, which is exactly
 * what Apple's requirement for an in-app deletion path forbids. Rather than
 * offering closure only to the trapped, it is offered to everyone: winding a
 * league down is a legitimate decision, and `has_transfer_target` decides only
 * whether the *transfer* option is shown as available.
 */

const TITLE_ID = 'delete-account-title';

export function DeleteAccount({ blockers }: { blockers: AccountDeletionBlocker[] }) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Imperative open, for the reason `LeagueStrip` documents at length: the
  // browser owns a `<dialog>`'s real state, and a `close` event React has not
  // processed yet leaves the two disagreeing — so a press in that window is a
  // no-op and the sheet never reopens.
  const openDialog = useCallback(() => {
    setOpen(true);
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // The element telling us it closed, which is not always news: HTML queues
  // `close` as a task, so a fast Escape-then-reopen delivers it after the sheet
  // is already back on screen.
  const onDialogClose = () => {
    if (dialogRef.current?.open === true) return;
    setOpen(false);
  };

  const onDialogClick = (event: MouseEvent<HTMLDialogElement>) => {
    const panel = panelRef.current;
    if (panel !== null && !panel.contains(event.target as Node)) {
      close();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openDialog}
        aria-haspopup="dialog"
        className="press flex min-h-control w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-whistle-50 dark:hover:bg-whistle-900/30"
      >
        <span
          aria-hidden="true"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-whistle-50 text-whistle-700 dark:bg-whistle-900/40 dark:text-whistle-200"
        >
          <AlertIcon size={18} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold text-whistle-700 dark:text-whistle-300">
            Delete account
          </span>
          <span className="truncate text-xs font-normal text-muted">
            Permanently remove your MatchDay account
          </span>
        </span>
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby={TITLE_ID}
        className="sheet-dialog"
        onClose={onDialogClose}
        onClick={onDialogClick}
      >
        {open ? (
          <div className="flex h-full w-full flex-col justify-end sm:items-center sm:justify-center">
            <div
              ref={panelRef}
              className="sheet-enter pb-safe flex max-h-[88dvh] w-full flex-col gap-4 overflow-y-auto rounded-t-[1.5rem] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-4 shadow-[var(--shadow-float)] sm:max-w-md sm:rounded-[var(--radius-lg)]"
            >
              {blockers.length > 0 ? (
                <BlockedByLeagues blockers={blockers} onCancel={close} />
              ) : (
                <ConfirmDeletion onCancel={close} />
              )}
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}

/** The administrator's screen: what is in the way, and the two ways out. */
function BlockedByLeagues({
  blockers,
  onCancel,
}: {
  blockers: AccountDeletionBlocker[];
  onCancel: () => void;
}) {
  return (
    <>
      <h2 id={TITLE_ID} className="text-base font-semibold">
        Deal with your {blockers.length === 1 ? 'league' : 'leagues'} first
      </h2>
      <p className="text-sm text-secondary">
        A league always needs one administrator, so your account cannot be deleted while you run
        {blockers.length === 1 ? ' one' : ' these'}. Hand each one over, or close it.
      </p>

      <ul className="divide-hairline flex flex-col rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
        {blockers.map((blocker) => (
          <li key={blocker.league_id} className="flex flex-col gap-3 p-3">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                {blocker.league_name}
              </span>
              <Badge tone="neutral">Admin</Badge>
            </div>

            {blocker.has_transfer_target ? (
              <Link href={`/leagues/${blocker.league_slug}/members` as Route} className="self-start">
                <Button variant="secondary" size="sm" icon={<UsersIcon size={16} />}>
                  Transfer administration
                </Button>
              </Link>
            ) : (
              // Said out loud rather than left as a missing button. Somebody
              // whose league has no other member would otherwise keep looking
              // for the transfer screen the copy above mentions.
              <p className="text-xs text-muted">
                Nobody else is active in this league, so there is no one to transfer it to.
              </p>
            )}

            <CloseLeagueForm leagueId={blocker.league_id} leagueName={blocker.league_name} />
          </li>
        ))}
      </ul>

      <div className="flex justify-end">
        <Button variant="ghost" onClick={onCancel}>
          Close
        </Button>
      </div>
    </>
  );
}

function CloseLeagueForm({ leagueId, leagueName }: { leagueId: string; leagueName: string }) {
  const [state, submit, pending] = useActionState(closeLeagueAction, null);
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <Button variant="danger" size="sm" onClick={() => setAsking(true)}>
        Close league
      </Button>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3">
      <input type="hidden" name="league_id" value={leagueId} />
      <p className="text-xs leading-relaxed text-secondary">
        Closing {leagueName} cancels every upcoming match and tells its members. Past matches,
        rosters and attendance are kept. This cannot be undone.
      </p>
      <Field
        label="Type “close” to confirm"
        htmlFor={`close-confirm-${leagueId}`}
        error={state?.ok === false ? state.fieldErrors?.confirm : undefined}
      >
        <input
          id={`close-confirm-${leagueId}`}
          name="confirm"
          autoComplete="off"
          className={inputClassName}
        />
      </Field>
      {state?.ok === false && state.fieldErrors?.confirm === undefined ? (
        <p role="alert" className="text-xs font-medium text-whistle-600 dark:text-whistle-300">
          {state.message}
        </p>
      ) : null}
      <div className="flex gap-2">
        <SubmitButton pending={pending} variant="secondary" block={false}>
          {pending ? 'Closing…' : 'Close league'}
        </SubmitButton>
        <Button variant="ghost" size="sm" onClick={() => setAsking(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The ordinary case: what deletion means, then proof of identity, then do it. */
function ConfirmDeletion({ onCancel }: { onCancel: () => void }) {
  const [state, submit, pending] = useActionState(deleteAccountAction, null);
  const [codeState, requestCode, requestingCode] = useActionState(requestDeletionCodeAction, null);

  /**
   * Which proof this person can give.
   *
   * MatchDay cannot tell whether an account has a password — finding out would
   * mean reading `auth.users.encrypted_password`, which the product does not do
   * — so it offers both rather than guessing and stranding the half it guessed
   * wrong about.
   */
  const [method, setMethod] = useState<'password' | 'code'>('password');

  return (
    <>
      <h2 id={TITLE_ID} className="text-base font-semibold">
        Delete your MatchDay account?
      </h2>

      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-secondary">
        <li>This is permanent and cannot be undone.</li>
        <li>Your account and personal details are removed.</li>
        <li>You are taken out of your leagues and any upcoming matches.</li>
        <li>
          Matches you have already played stay in each league&rsquo;s records, but without your name
          or photo.
        </li>
      </ul>

      <form action={submit} className="flex flex-col gap-3">
        <input type="hidden" name="method" value={method} />

        {method === 'password' ? (
          <>
            <Field
              label="Confirm your password"
              htmlFor="delete-password"
              error={state?.ok === false ? state.fieldErrors?.password : undefined}
            >
              <input
                id="delete-password"
                name="password"
                type="password"
                autoComplete="current-password"
                className={inputClassName}
              />
            </Field>
            <button
              type="button"
              onClick={() => setMethod('code')}
              className="press self-start text-sm font-medium text-pitch-700 underline decoration-pitch-500/40 underline-offset-4 dark:text-pitch-300"
            >
              I don&rsquo;t have a password — email me a code
            </button>
          </>
        ) : (
          <>
            <Field
              label="Code from your email"
              htmlFor="delete-token"
              error={state?.ok === false ? state.fieldErrors?.token : undefined}
            >
              <input
                id="delete-token"
                name="token"
                inputMode="numeric"
                autoComplete="one-time-code"
                className={inputClassName}
              />
            </Field>
            {codeState?.ok === true ? (
              <Notice tone="success">Code sent. Check your email.</Notice>
            ) : null}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setMethod('password')}
                className="press text-sm font-medium text-pitch-700 underline decoration-pitch-500/40 underline-offset-4 dark:text-pitch-300"
              >
                Use my password
              </button>
            </div>
          </>
        )}

        {state?.ok === false &&
        state.fieldErrors?.password === undefined &&
        state.fieldErrors?.token === undefined ? (
          <p role="alert" className="text-sm font-medium text-whistle-600 dark:text-whistle-300">
            {state.message}
          </p>
        ) : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={pending} icon={<LogOutIcon size={16} />}>
            {pending ? 'Deleting…' : 'Delete my account'}
          </Button>
        </div>
      </form>

      {/* Its own form, because it is a different action. Outside the one above,
          because nested forms are not a thing HTML has. */}
      {method === 'code' ? (
        <form action={requestCode}>
          <Button type="submit" variant="ghost" size="sm" disabled={requestingCode}>
            {requestingCode ? 'Sending…' : 'Send me a code'}
          </Button>
        </form>
      ) : null}
    </>
  );
}

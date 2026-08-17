'use client';

import { useActionState } from 'react';
import { CheckIcon, ChevronRightIcon } from '@/components/ui/icon';
import {
  archiveNotificationAction,
  markAllNotificationsReadAction,
  markNotificationReadAction,
  markNotificationUnreadAction,
  openNotificationAction,
  unarchiveNotificationAction,
} from '@/server/actions/notifications';
import type { NotificationRow } from '@/types/database';

/**
 * The inbox.
 *
 * Newest first, unread marked, with the three mutations 02 §14 asks for.
 *
 * Archiving takes a row out of this list and out of the unread badge — the
 * reads have always filtered `archived_at is null`, so Phase 5 completes a
 * behaviour rather than inventing one. It deliberately leaves `read_at` alone:
 * "I am done with this" is not the claim "I read this", and overwriting the
 * timestamp would destroy the only record of whether they ever did. Nothing is
 * deleted, so an archived notification remains in the history.
 *
 * There is no separate archive view. Retention and browsing history are a
 * design nobody has asked for yet; `unarchive` exists so an accidental press is
 * recoverable through the archived list a later phase may add.
 *
 * Every row links to a deep link the target page re-authorizes. Following one
 * after losing a membership lands on a redirect, not on member-only content.
 */
export function NotificationRowItem({ notification }: { notification: NotificationRow }) {
  const [readState, markRead, markingRead] = useActionState(markNotificationReadAction, null);
  const [unreadState, markUnread, markingUnread] = useActionState(
    markNotificationUnreadAction,
    null,
  );
  const [archiveState, archive, archiving] = useActionState(archiveNotificationAction, null);
  const [restoreState, restore, restoring] = useActionState(unarchiveNotificationAction, null);

  const unread = notification.read_at === null;
  const archived = notification.archived_at !== null;
  const state = [readState, unreadState, archiveState, restoreState].find(
    (candidate) => candidate?.ok === false,
  );

  return (
    <li
      className={`surface-card animate-rise relative flex flex-col gap-3 p-4 ${
        unread ? 'border-pitch-300 dark:border-pitch-800' : ''
      }`}
    >
      {/* Unread is a rail down the leading edge rather than a bullet glued to
          the title. It survives a long title wrapping, it does not shift the
          text, and it is the one thing on the card that can be scanned down a
          column of twenty. */}
      {unread ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-3 left-0 w-1 rounded-r-full bg-pitch-500"
        />
      ) : null}

      <div className={`flex items-start justify-between gap-3 ${unread ? 'pl-2' : ''}`}>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-semibold leading-snug">
            {unread ? <span className="sr-only">Unread. </span> : null}
            {notification.title}
          </p>
          <p className="text-sm leading-relaxed text-secondary">{notification.body}</p>
        </div>
        <time dateTime={notification.created_at} className="shrink-0 text-xs text-muted">
          {new Date(notification.created_at).toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
          })}
        </time>
      </div>

      <div className={`flex flex-wrap items-center gap-2 ${unread ? 'pl-2' : ''}`}>
        {/* A form, not a link — see `openNotificationAction` for why, and for
            what that costs. One tap marks this notification read and lands on
            the thing it is about, which is what "opening" it has always meant
            to everybody except the code. */}
        <form action={openNotificationAction} className="inline">
          <input type="hidden" name="notification_id" value={notification.id} />
          <button
            type="submit"
            className="press inline-flex min-h-control items-center gap-1.5 rounded-[var(--radius-md)] bg-pitch-600 px-3.5 py-2 text-sm font-semibold text-white shadow-[var(--shadow-card)] hover:bg-pitch-700 dark:bg-pitch-500 dark:text-pitch-950 dark:hover:bg-pitch-400"
          >
            Open
            <ChevronRightIcon size={15} />
          </button>
        </form>

        <form action={unread ? markRead : markUnread} className="inline">
          <input type="hidden" name="notification_id" value={notification.id} />
          <button
            type="submit"
            disabled={markingRead || markingUnread}
            className="press inline-flex min-h-control items-center rounded-[var(--radius-md)] px-2.5 py-2 text-sm font-medium text-secondary hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-55"
          >
            {markingRead || markingUnread
              ? 'Working…'
              : unread
                ? 'Mark as read'
                : 'Mark as unread'}
          </button>
        </form>

        <form action={archived ? restore : archive} className="inline">
          <input type="hidden" name="notification_id" value={notification.id} />
          <button
            type="submit"
            disabled={archiving || restoring}
            className="press inline-flex min-h-control items-center rounded-[var(--radius-md)] px-2.5 py-2 text-sm font-medium text-secondary hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-55"
          >
            {archiving || restoring ? 'Working…' : archived ? 'Restore' : 'Archive'}
          </button>
        </form>
      </div>

      {state?.ok === false ? (
        <p role="alert" className="text-sm font-medium text-whistle-600 dark:text-whistle-300">
          {state.message}
        </p>
      ) : null}
    </li>
  );
}

export function MarkAllReadButton({ unreadCount }: { unreadCount: number }) {
  const [state, submit, pending] = useActionState(markAllNotificationsReadAction, null);

  if (unreadCount === 0) {
    return null;
  }

  return (
    <form action={submit}>
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className="press inline-flex min-h-control items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3.5 py-2 text-sm font-semibold hover:bg-[var(--surface-hover)] disabled:pointer-events-none disabled:opacity-55"
      >
        <CheckIcon size={16} />
        {pending ? 'Marking…' : `Mark all ${unreadCount} as read`}
      </button>
      {state?.ok === false ? (
        <p role="alert" className="mt-1 text-sm font-medium text-whistle-600 dark:text-whistle-300">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

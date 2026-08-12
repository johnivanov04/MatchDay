'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import {
  archiveNotificationAction,
  markAllNotificationsReadAction,
  markNotificationReadAction,
  markNotificationUnreadAction,
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
      className={`surface-card flex flex-col gap-2 p-4 ${
        unread ? 'border-pitch-500/50' : 'opacity-80'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">
            {unread ? (
              <span aria-label="Unread" className="mr-1.5 text-pitch-600">
                ●
              </span>
            ) : null}
            {notification.title}
          </p>
          <p className="mt-0.5 text-sm text-muted">{notification.body}</p>
        </div>
        <time
          dateTime={notification.created_at}
          className="shrink-0 text-xs text-muted"
        >
          {new Date(notification.created_at).toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
          })}
        </time>
      </div>

      <div className="flex items-center gap-3">
        <Link
          href={notification.deep_link}
          className="text-sm font-semibold underline underline-offset-4"
        >
          Open
        </Link>

        <form action={unread ? markRead : markUnread} className="inline">
          <input type="hidden" name="notification_id" value={notification.id} />
          <button
            type="submit"
            disabled={markingRead || markingUnread}
            className="text-sm underline underline-offset-4 disabled:opacity-60"
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
            className="text-sm underline underline-offset-4 disabled:opacity-60"
          >
            {archiving || restoring ? 'Working…' : archived ? 'Restore' : 'Archive'}
          </button>
        </form>
      </div>

      {state?.ok === false ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
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
        className="min-h-10 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm font-semibold disabled:opacity-60"
      >
        {pending ? 'Marking…' : `Mark all ${unreadCount} as read`}
      </button>
      {state?.ok === false ? (
        <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

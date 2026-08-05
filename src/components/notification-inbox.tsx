'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from '@/server/actions/notifications';
import type { NotificationRow } from '@/types/database';

/**
 * The inbox.
 *
 * Deliberately plain: newest first, unread marked, one action. The v0.2 roadmap
 * puts manual unread/archive controls and retention in a later phase, and the
 * schema already carries `read_at` and `archived_at` so adding them is a
 * feature rather than a migration. Building filtering now would be guessing at
 * a design nobody has asked for yet.
 *
 * Every row links to a deep link the target page re-authorizes. Following one
 * after losing a membership lands on a redirect, not on member-only content.
 */
export function NotificationRowItem({ notification }: { notification: NotificationRow }) {
  const [state, submit, pending] = useActionState(markNotificationReadAction, null);
  const unread = notification.read_at === null;

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

        {unread ? (
          <form action={submit} className="inline">
            <input type="hidden" name="notification_id" value={notification.id} />
            <button
              type="submit"
              disabled={pending}
              className="text-sm underline underline-offset-4 disabled:opacity-60"
            >
              {pending ? 'Marking…' : 'Mark as read'}
            </button>
          </form>
        ) : null}
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

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { safeRedirectPath } from '@/lib/auth/safe-redirect';
import { requireSessionUser } from '@/lib/auth/session';
import { actionFailure, actionSuccess, type ActionResult } from '@/lib/errors';
import { domainErrorFromDatabase } from '@/lib/errors-from-database';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Inbox mutations.
 *
 * Neither action takes a user id. `mark_notification_read()` scopes its UPDATE
 * to `recipient_user_id = auth.uid()`, so naming somebody else's notification
 * is a miss — indistinguishable from an id that does not exist.
 */

export async function markNotificationReadAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    await requireSessionUser();
    const notificationId = z.uuid().parse(formData.get('notification_id') ?? '');

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('mark_notification_read', {
      p_notification_id: notificationId,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/**
 * Opening a notification: marks it read, then goes where it points.
 *
 * ── THE BUG THIS FIXES ─────────────────────────────────────────────────────
 *
 * "Open" was a plain link. Somebody tapped it, read the thing it was about, and
 * came back to an inbox still insisting the notification was unread — because
 * the only control that ever wrote `read_at` was the *secondary* "Mark as read"
 * button beside it, which nobody presses after they have already read it. The
 * unread count was never wrong; it was faithfully reporting a timestamp nothing
 * on the path people actually take had ever written.
 *
 * ── WHY THE DESTINATION IS READ BACK FROM THE DATABASE ─────────────────────
 *
 * This is a server-side `redirect()`, so the target is a genuine open-redirect
 * surface — unlike the anchor it replaces, where the browser was the only thing
 * following the href. The deep link is therefore **never taken from the form**.
 * Only the notification id crosses the wire; the path comes from the row, which
 * a CHECK constraint already restricts to `^/[^/\\]`, and which `notifications`
 * RLS only lets the recipient read at all.
 *
 * `safeRedirectPath` is then a second, independent layer over that. It cannot
 * currently fire — the constraint would have to have been dropped for a row to
 * hold anything else — which is exactly why it belongs here rather than being
 * left to the day somebody changes the schema.
 *
 * ── THE TRADEOFF ───────────────────────────────────────────────────────────
 *
 * A form submission, not an anchor, so middle-click and "open in new tab" are
 * gone from this control. Keeping both would mean either firing the mutation
 * from an `onClick` and racing the navigation, or marking read inside the
 * destination page — which would then mark it read for somebody arriving from a
 * push notification, a bookmark or a link in another league's chat. MatchDay is
 * a phone product; a reliable single tap is worth more than a middle-click
 * nobody performs on a touchscreen.
 */
export async function openNotificationAction(formData: FormData): Promise<void> {
  let destination: string;

  try {
    await requireSessionUser();
    const notificationId = z.uuid().parse(formData.get('notification_id') ?? '');

    const supabase = await createSupabaseServerClient();

    // Idempotent by construction: `mark_notification_read` coalesces `read_at`,
    // so re-opening something already read does not rewrite the timestamp.
    const { error } = await supabase.rpc('mark_notification_read', {
      p_notification_id: notificationId,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    const { data } = await supabase
      .from('notifications')
      .select('deep_link')
      .eq('id', notificationId)
      .maybeSingle();

    destination = safeRedirectPath(data?.deep_link ?? null);
  } catch {
    // A notification that has gone, or one that was never this user's, is not
    // worth an error screen: the inbox is one navigation away and will show the
    // truth. Nothing about which of the two it was is disclosed.
    redirect('/notifications');
  }

  // The badge renders from the layout, so the count is stale on every page
  // until this runs — including the page being navigated to.
  revalidatePath('/', 'layout');
  redirect(destination);
}

/**
 * The three remaining inbox mutations, which differ only in the RPC.
 *
 * None takes a user id. Each database function scopes its UPDATE to
 * `recipient_user_id = auth.uid()`, so naming another person's notification is
 * a miss rather than a cross-user write — and reports `NOTIFICATION_NOT_FOUND`,
 * which is the same answer an identifier that does not exist gets.
 */
async function notificationMutation(
  rpc: 'mark_notification_unread' | 'archive_notification' | 'unarchive_notification',
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    await requireSessionUser();
    const notificationId = z.uuid().parse(formData.get('notification_id') ?? '');

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc(rpc, { p_notification_id: notificationId });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

export async function markNotificationUnreadAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return notificationMutation('mark_notification_unread', formData);
}

/**
 * Archiving takes the row out of the active inbox and out of the unread count —
 * which is what `getMyNotifications` and `getUnreadNotificationCount` already
 * filter on, so this completes a behaviour the reads have always assumed.
 *
 * `read_at` is left untouched. "I am done with this" is not the same claim as
 * "I read this", and overwriting the timestamp would destroy the only record of
 * whether they ever did. Nothing is deleted.
 */
export async function archiveNotificationAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return notificationMutation('archive_notification', formData);
}

export async function unarchiveNotificationAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return notificationMutation('unarchive_notification', formData);
}

export async function markAllNotificationsReadAction(
  _previous: ActionResult<undefined> | null,
  _formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    await requireSessionUser();

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('mark_all_notifications_read', {});

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

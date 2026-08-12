'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
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

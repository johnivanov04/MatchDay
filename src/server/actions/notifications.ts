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

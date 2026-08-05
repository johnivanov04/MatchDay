import 'server-only';

import { cache } from 'react';
import { requireSessionUser } from '@/lib/auth/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { NotificationRow } from '@/types/database';

/**
 * Notification reads.
 *
 * `notifications_select_self` restricts every query below to the caller's own
 * rows, so none of these functions filters by user id — and none of them
 * accepts one. Even a league administrator cannot read a member's inbox: a
 * notification is addressed to a person, not to a tenant.
 */

/**
 * Unread count for the header badge.
 *
 * Wrapped in React's `cache` because the app shell renders on every
 * authenticated page and would otherwise ask once per render pass. Returns 0 on
 * failure: a badge is not worth failing a page render over, and the inbox
 * itself surfaces the real state.
 */
export const getUnreadNotificationCount = cache(async (): Promise<number> => {
  await requireSessionUser();
  const supabase = await createSupabaseServerClient();

  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null)
    .is('archived_at', null);

  if (error !== null || count === null) {
    return 0;
  }

  return count;
});

/** The inbox, newest first. */
export async function getMyNotifications(limit = 50): Promise<NotificationRow[]> {
  await requireSessionUser();
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error !== null) {
    return [];
  }

  return data ?? [];
}

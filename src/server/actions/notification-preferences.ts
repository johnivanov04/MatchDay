'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireSessionUser } from '@/lib/auth/session';
import { actionFailure, actionSuccess, type ActionResult } from '@/lib/errors';
import { domainErrorFromDatabase } from '@/lib/errors-from-database';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { NOTIFICATION_TYPE_META } from '@/lib/notifications/notification-types';
import type { NotificationChannel, NotificationType } from '@/types/database';

/**
 * The global email-notifications switch.
 *
 * ── NO PROVIDER CODE HERE, DELIBERATELY ────────────────────────────────────
 *
 * This module writes a boolean and returns. It does not import Resend, does not
 * know an API key exists, and cannot send anything. Toggling the setting is a
 * preference change, not a delivery event — and the request path has been free
 * of provider calls since Phase 3B, which is a property worth keeping rather
 * than quietly reintroducing through a settings screen.
 *
 * ── THE ROW IS CREATED ON DEMAND ───────────────────────────────────────────
 *
 * Nobody has a preferences row until they touch this. Absence means off, which
 * is what let Phase 3D ship without emailing every existing member and without
 * a backfill. The upsert is the only thing that creates one.
 */

const preferenceSchema = z.object({
  email_enabled: z.enum(['true', 'false']).transform((value) => value === 'true'),
});

export async function setEmailNotificationsEnabledAction(
  _previous: ActionResult<boolean> | null,
  formData: FormData,
): Promise<ActionResult<boolean>> {
  try {
    const parsed = preferenceSchema.safeParse({
      email_enabled: formData.get('email_enabled') ?? 'false',
    });

    if (!parsed.success) {
      // A malformed value is a broken client, not something to explain in
      // product language. `VALIDATION_FAILED` is the existing code for it.
      throw domainErrorFromDatabase({ code: 'invalid_input', message: 'invalid preference' });
    }

    // The session, not the form. The user id is never accepted from a request:
    // RLS would refuse a mismatch anyway, and taking it from the form would
    // make the policy the only thing standing between one member and another's
    // settings.
    const user = await requireSessionUser();
    const supabase = await createSupabaseServerClient();

    const { error } = await supabase
      .from('notification_preferences')
      .upsert(
        { user_id: user.id, email_enabled: parsed.data.email_enabled },
        { onConflict: 'user_id' },
      );

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/settings/notifications');
    return actionSuccess(parsed.data.email_enabled);
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/**
 * One per-type external delivery override.
 *
 * ── SPARSE, AND UPSERTED ───────────────────────────────────────────────────
 *
 * Absence of a row means enabled, and this writes an explicit row either way
 * rather than deleting on a return to the default. One consistent model: every
 * toggle is the same idempotent upsert, and the primary key on (user, type,
 * channel) is what makes two browser tabs racing produce one row instead of
 * two.
 *
 * The alternative — delete when returning to default — would mean the write
 * path has to decide which operation it is performing, and a lost delete would
 * silently leave a member disabled.
 *
 * ── NO PROVIDER CODE, AGAIN ────────────────────────────────────────────────
 *
 * This writes a boolean. It cannot send anything, and a settings screen is
 * exactly where a provider call would be easy to reintroduce by accident.
 */
const typePreferenceSchema = z.object({
  notification_type: z.string().refine(
    (value): value is NotificationType =>
      Object.hasOwn(NOTIFICATION_TYPE_META, value) &&
      NOTIFICATION_TYPE_META[value as NotificationType].configurable,
    // A type that is in-app only has no external delivery to configure, so a
    // request naming one is a broken client rather than a preference.
    { message: 'That notification type cannot be configured.' },
  ),
  channel: z.enum(['push', 'email']),
  enabled: z.enum(['true', 'false']).transform((value) => value === 'true'),
});

export async function setNotificationTypePreferenceAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const parsed = typePreferenceSchema.safeParse({
      notification_type: formData.get('notification_type') ?? '',
      channel: formData.get('channel') ?? '',
      enabled: formData.get('enabled') ?? 'true',
    });

    if (!parsed.success) {
      throw domainErrorFromDatabase({ code: 'invalid_input', message: 'invalid preference' });
    }

    // From the session, never the form. RLS would refuse a mismatch anyway, but
    // taking it from the request would make the policy the only thing between
    // one member and another's settings.
    const user = await requireSessionUser();
    const supabase = await createSupabaseServerClient();

    const { error } = await supabase.from('notification_type_preferences').upsert(
      {
        user_id: user.id,
        notification_type: parsed.data.notification_type,
        channel: parsed.data.channel as NotificationChannel,
        enabled: parsed.data.enabled,
      },
      { onConflict: 'user_id,notification_type,channel' },
    );

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/settings/notifications');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

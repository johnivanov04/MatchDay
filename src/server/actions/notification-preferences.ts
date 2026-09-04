'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireSessionUser } from '@/lib/auth/session';
import { actionFailure, actionSuccess, type ActionResult } from '@/lib/errors';
import { domainErrorFromDatabase } from '@/lib/errors-from-database';
import { createSupabaseServerClient } from '@/lib/supabase/server';

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

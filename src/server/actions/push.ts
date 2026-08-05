'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireSessionUser } from '@/lib/auth/session';
import { actionFailure, actionSuccess, DomainError, type ActionResult } from '@/lib/errors';
import { domainErrorFromDatabase } from '@/lib/errors-from-database';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Push subscription management.
 *
 * The browser produces the endpoint and keys; this action stores them. Note
 * that nothing here ever reads them back — the column grant makes that
 * impossible for a client role, and the UI has no need. A device is identified
 * to the user by its label and its id, never by its credential.
 */

const subscriptionSchema = z.object({
  endpoint: z
    .string()
    .trim()
    .min(20)
    .max(2048)
    .refine((value) => value.startsWith('https://'), {
      message: 'That subscription is not valid.',
    }),
  p256dh: z.string().trim().min(16).max(256),
  auth: z.string().trim().min(8).max(256),
  device_label: z
    .string()
    .trim()
    .max(80)
    .transform((value): string | null => (value === '' ? null : value)),
});

export async function registerPushSubscriptionAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    await requireSessionUser();

    const parsed = subscriptionSchema.safeParse({
      endpoint: formData.get('endpoint') ?? '',
      p256dh: formData.get('p256dh') ?? '',
      auth: formData.get('auth') ?? '',
      device_label: formData.get('device_label') ?? '',
    });

    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', {
        fieldErrors: { form: 'That subscription could not be registered.' },
      });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('register_push_subscription', {
      p_endpoint: parsed.data.endpoint,
      p_p256dh: parsed.data.p256dh,
      p_auth: parsed.data.auth,
      p_device_label: parsed.data.device_label,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/settings/devices');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

export async function setPushSubscriptionEnabledAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    await requireSessionUser();
    const subscriptionId = z.uuid().parse(formData.get('subscription_id') ?? '');
    const enabled = formData.get('enabled') === 'true';

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('set_push_subscription_enabled', {
      p_subscription_id: subscriptionId,
      p_enabled: enabled,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/settings/devices');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

export async function removePushSubscriptionAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    await requireSessionUser();
    const subscriptionId = z.uuid().parse(formData.get('subscription_id') ?? '');

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('remove_push_subscription', {
      p_subscription_id: subscriptionId,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/settings/devices');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

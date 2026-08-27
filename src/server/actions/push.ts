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

/**
 * APNs device registration, from the native iOS app.
 *
 * The app produces the token, reads its own signed `aps-environment`, and
 * carries a stable installation id; this stores all three. As with Web Push,
 * nothing here ever reads a token back — the column is granted to no client
 * role at all.
 */
const apnsDeviceSchema = z.object({
  // Uppercase hex of even length, matching what `PushNotifications` emits and
  // what `push_subscriptions_device_token_shape` accepts. No exact length is
  // asserted: Apple documents the token as variable, and pinning one would turn
  // a future widening into a simultaneous failure on every device.
  device_token: z
    .string()
    .trim()
    .min(2)
    .max(512)
    .regex(/^[0-9A-Fa-f]+$/, 'That device could not be registered.')
    .refine((value) => value.length % 2 === 0, 'That device could not be registered.')
    .transform((value) => value.toUpperCase()),
  environment: z.enum(['development', 'production']),
  installation_id: z.string().trim().regex(/^[A-Za-z0-9_-]{8,64}$/),
  device_label: z
    .string()
    .trim()
    .max(80)
    .transform((value): string | null => (value === '' ? null : value)),
});

export async function registerApnsDeviceAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    await requireSessionUser();

    const parsed = apnsDeviceSchema.safeParse({
      device_token: formData.get('device_token') ?? '',
      environment: formData.get('environment') ?? '',
      installation_id: formData.get('installation_id') ?? '',
      device_label: formData.get('device_label') ?? '',
    });

    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', {
        fieldErrors: { form: 'That device could not be registered.' },
      });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('register_apns_device', {
      p_device_token: parsed.data.device_token,
      p_environment: parsed.data.environment,
      p_installation_id: parsed.data.installation_id,
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

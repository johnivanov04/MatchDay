'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentProfile, requireSessionUser } from '@/lib/auth/session';
import { actionFailure, actionSuccess, DomainError, type ActionResult } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  parseGoalkeeperWillingFromForm,
  parsePositionsFromForm,
  profileInputSchema,
  toFieldErrors,
  toProfileUpdate,
} from '@/lib/validation/profile';

/**
 * Creates or updates the current user's global profile.
 *
 * The row's identity is never taken from the form. `id` comes from the verified
 * session and `email_normalized` is overwritten by a database trigger from the
 * JWT's email claim, so neither can be steered by what the client submits.
 */
export async function saveProfileAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const user = await requireSessionUser();

    const parsed = profileInputSchema.safeParse({
      first_name: formData.get('first_name') ?? '',
      last_name: formData.get('last_name') ?? '',
      phone: formData.get('phone') ?? '',
      gender: formData.get('gender') ?? '',
      preferred_positions: parsePositionsFromForm(formData),
      goalkeeper_willing: parseGoalkeeperWillingFromForm(formData),
      profile_photo_url: formData.get('profile_photo_url') ?? '',
    });

    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', { fieldErrors: toFieldErrors(parsed.error) });
    }

    const supabase = await createSupabaseServerClient();
    const existing = await getCurrentProfile();
    const writable = toProfileUpdate(parsed.data);

    const { error } =
      existing === null
        ? await supabase.from('profiles').insert({
            id: user.id,
            email_normalized: user.email,
            ...writable,
          })
        : await supabase.from('profiles').update(writable).eq('id', user.id);

    if (error !== null) {
      throw new DomainError('VALIDATION_FAILED', {
        cause: error,
        fieldErrors: { form: 'We could not save your profile. Please check your details.' },
      });
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

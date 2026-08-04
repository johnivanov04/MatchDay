import { z } from 'zod';
import type { ProfileWritableFields } from '@/types/database';

/**
 * Profile input validation.
 *
 * These bounds intentionally mirror the CHECK constraints in
 * `20260803010200_profiles.sql`. The database is the authority — this layer
 * exists to produce a helpful field-level message instead of a raw constraint
 * violation, never to be the only thing standing between bad input and the
 * table. Neither a skill level nor a rating appears here, because no such
 * column exists (PRD §5).
 */

const optionalText = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length <= max, { message: `Use ${max} characters or fewer.` })
    .transform((value): string | null => (value === '' ? null : value));

const requiredName = (label: string) =>
  z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length >= 1, { message: `${label} is required.` })
    .refine((value) => value.length <= 80, { message: `${label} must be 80 characters or fewer.` });

export const profileInputSchema = z.object({
  first_name: requiredName('First name'),
  last_name: requiredName('Last name'),

  phone: optionalText(32),
  gender: optionalText(64),

  preferred_positions: z
    .array(z.string())
    .max(8, { message: 'Choose up to 8 positions.' })
    .transform((values) =>
      values.map((value) => value.trim()).filter((value) => value.length > 0 && value.length <= 40),
    )
    .default([]),

  goalkeeper_willing: z.union([z.boolean(), z.null()]).default(null),

  profile_photo_url: z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value === '' || /^https:\/\//.test(value), {
      message: 'Use a full https:// address.',
    })
    .refine((value) => value.length <= 2048, { message: 'That address is too long.' })
    .transform((value): string | null => (value === '' ? null : value)),
});

export type ProfileInput = z.infer<typeof profileInputSchema>;

/** Narrows the validated input to exactly the columns a user may write. */
export function toProfileUpdate(input: ProfileInput): ProfileWritableFields {
  return {
    first_name: input.first_name,
    last_name: input.last_name,
    phone: input.phone,
    gender: input.gender,
    preferred_positions: input.preferred_positions,
    goalkeeper_willing: input.goalkeeper_willing,
    profile_photo_url: input.profile_photo_url,
  };
}

/** Converts a Zod failure into the `fieldErrors` shape used by `DomainError`. */
export function toFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && fieldErrors[field] === undefined) {
      fieldErrors[field] = issue.message;
    }
  }
  return fieldErrors;
}

/** Parses the multi-value `preferred_positions` field out of a submitted form. */
export function parsePositionsFromForm(formData: FormData): string[] {
  const raw = formData.get('preferred_positions');
  if (typeof raw !== 'string') {
    return [];
  }
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** Reads the tri-state goalkeeper field: yes, no, or "not answered". */
export function parseGoalkeeperWillingFromForm(formData: FormData): boolean | null {
  const raw = formData.get('goalkeeper_willing');
  if (raw === 'yes') return true;
  if (raw === 'no') return false;
  return null;
}

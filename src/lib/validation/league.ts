import { z } from 'zod';

/**
 * League input validation.
 *
 * Bounds mirror the CHECK constraints in `20260803010300_leagues.sql`. The
 * database remains the authority — this layer exists to turn a constraint
 * violation into a field-level message, never to be the only thing between bad
 * input and the table.
 *
 * Note what is absent: `visibility` is not part of the create schema. New
 * leagues are private (PRD §6) and `create_league()` hard-codes that, so there
 * is nothing for a client to supply.
 */

const trimmed = () => z.string().transform((value) => value.trim());

const requiredText = (label: string, min: number, max: number) =>
  trimmed()
    .refine((value) => value.length >= min, { message: `${label} is required.` })
    .refine((value) => value.length <= max, {
      message: `${label} must be ${max} characters or fewer.`,
    });

const optionalText = (max: number) =>
  trimmed()
    .refine((value) => value.length <= max, { message: `Use ${max} characters or fewer.` })
    .transform((value): string | null => (value === '' ? null : value));

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const leagueSlugSchema = trimmed()
  .transform((value) => value.toLowerCase())
  .refine((value) => value.length >= 3 && value.length <= 60, {
    message: 'Use between 3 and 60 characters.',
  })
  .refine((value) => SLUG_PATTERN.test(value), {
    message: 'Use lowercase letters, numbers and single hyphens, e.g. sunday-futsal.',
  });

/**
 * Latin letters that carry no combining accent, so NFKD leaves them intact.
 * Without these, a Danish or German league name loses characters rather than
 * transliterating them — "København" would become "k-benhavn".
 */
const NON_DECOMPOSING_LETTERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ø/g, 'o'],
  [/æ/g, 'ae'],
  [/œ/g, 'oe'],
  [/å/g, 'a'],
  [/ß/g, 'ss'],
  [/đ/g, 'd'],
  [/ð/g, 'd'],
  [/þ/g, 'th'],
  [/ł/g, 'l'],
  [/ı/g, 'i'],
];

/** Suggests a slug from a league name. Advisory only — the user may override it. */
export function slugifyLeagueName(name: string): string {
  const transliterated = NON_DECOMPOSING_LETTERS.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    name.toLowerCase(),
  );

  return transliterated
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

const capacitySchema = z.coerce
  .number()
  .int({ message: 'Enter a whole number.' })
  .min(2, { message: 'Capacity must be at least 2.' })
  .max(200, { message: 'Capacity must be 200 or fewer.' });

const minPlayersSchema = z.coerce
  .number()
  .int({ message: 'Enter a whole number.' })
  .min(0, { message: 'Cannot be negative.' })
  .max(200, { message: 'Must be 200 or fewer.' });

const teamCountSchema = z.coerce
  .number()
  .int({ message: 'Enter a whole number.' })
  .min(2, { message: 'A match needs at least 2 teams.' })
  .max(20, { message: 'Use 20 teams or fewer.' });

const baseLeagueFields = {
  name: requiredText('League name', 2, 120),
  general_area: requiredText('General area', 1, 120),
  timezone: requiredText('Timezone', 1, 64),
  sport_label: requiredText('Sport or format', 1, 60),
  description: requiredText('Short description', 1, 280),
  default_capacity: capacitySchema,
  default_min_players: minPlayersSchema,
  default_selection_mode: z.enum(['first_come', 'admin_approval']),
  default_waitlist_mode: z.enum(['automatic', 'admin_controlled']),
  default_team_count: teamCountSchema,
  default_location: optionalText(160),
  typical_schedule: optionalText(160),
  gender_field_enabled: z.boolean(),
  goalkeeper_field_enabled: z.boolean(),
};

/** Mirrors `leagues_default_min_players_range`. */
const thresholdWithinCapacity = (
  value: { default_capacity: number; default_min_players: number },
  ctx: z.RefinementCtx,
): void => {
  if (value.default_min_players > value.default_capacity) {
    ctx.addIssue({
      code: 'custom',
      path: ['default_min_players'],
      message: 'The minimum cannot exceed the capacity.',
    });
  }
};

export const createLeagueSchema = z
  .object({ ...baseLeagueFields, slug: leagueSlugSchema })
  .superRefine(thresholdWithinCapacity);

export const updateLeagueSettingsSchema = z
  .object(baseLeagueFields)
  .superRefine(thresholdWithinCapacity);

export type CreateLeagueInput = z.infer<typeof createLeagueSchema>;
export type UpdateLeagueSettingsInput = z.infer<typeof updateLeagueSettingsSchema>;

export const leagueVisibilitySchema = z.enum(['private', 'searchable']);

export const joinRequestMessageSchema = optionalText(500);
export const decisionNoteSchema = optionalText(500);

export const inviteOptionsSchema = z.object({
  label: optionalText(120),
  grants_status: z.enum(['active', 'pending']),
  // Blank means unlimited.
  max_uses: z
    .union([z.literal(''), z.coerce.number().int().min(1).max(1000)])
    .transform((value): number | null => (value === '' ? null : value)),
  expires_in_days: z.coerce
    .number()
    .int()
    .min(1, { message: 'Must be at least 1 day.' })
    .max(90, { message: 'Must be 90 days or fewer.' }),
});

export const memberEmailSchema = trimmed()
  .transform((value) => value.toLowerCase())
  .pipe(z.email({ message: 'Enter a valid email address.' }));

export const membershipStatusSchema = z.enum(['pending', 'active', 'suspended', 'removed']);

/**
 * Why an administrator suspended, removed or reactivated a member.
 *
 * 500 characters, matching the column check. Optional here and required by the
 * action for anything but a reactivation, so the two failure modes — "you wrote
 * too much" and "you have to say why" — read differently.
 */
export const membershipStatusReasonSchema = optionalText(500);

/**
 * When the administrator intends to lift a suspension.
 *
 * Informational: nothing expires it, and reactivation stays a deliberate act.
 * Blank is the normal case — an indefinite suspension — so an empty string
 * becomes null rather than a validation error.
 */
export const suspendedUntilSchema = trimmed().transform((value): string | null => {
  if (value === '') {
    return null;
  }

  // `<input type="date">` submits `YYYY-MM-DD`. Interpreted at the end of that
  // day so "suspended until the 30th" includes the 30th.
  const parsed = new Date(`${value}T23:59:59`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
});

/**
 * Sanitises a discovery query before it reaches PostgREST.
 *
 * `%`, `_` and `,` are stripped rather than escaped: `%` and `_` are `ILIKE`
 * wildcards that would let a crafted query match everything, and `,` is
 * PostgREST's separator inside `or=(...)`, where an unescaped one would let a
 * caller append filters of their own choosing.
 */
export function sanitizeSearchQuery(raw: string): string {
  return raw
    .trim()
    .replace(/[%_,()*\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim();
}

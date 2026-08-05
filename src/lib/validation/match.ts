import { z } from 'zod';

/**
 * Template and match input validation.
 *
 * Bounds mirror the CHECK constraints in `20260805030200_matches.sql`. The
 * database remains the authority — this layer turns a constraint violation into
 * a field-level message rather than being the thing that prevents it.
 */

const trimmed = () => z.string().transform((value) => value.trim());

const requiredText = (label: string, max: number) =>
  trimmed()
    .refine((value) => value.length >= 1, { message: `${label} is required.` })
    .refine((value) => value.length <= max, {
      message: `${label} must be ${max} characters or fewer.`,
    });

const optionalText = (max: number) =>
  trimmed()
    .refine((value) => value.length <= max, { message: `Use ${max} characters or fewer.` })
    .transform((value): string | null => (value === '' ? null : value));

const optionalHttpsUrl = () =>
  trimmed()
    .refine((value) => value === '' || /^https:\/\//.test(value), {
      message: 'Use a full https:// address.',
    })
    .refine((value) => value.length <= 2048, { message: 'That address is too long.' })
    .transform((value): string | null => (value === '' ? null : value));

/** `HH:MM`, 24-hour. Matches what an `<input type="time">` submits. */
export const localTimeSchema = trimmed().refine(
  (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value),
  { message: 'Use a 24-hour time such as 19:00.' },
);

/** `YYYY-MM-DD`, and a real calendar date rather than merely well-shaped. */
export const localDateSchema = trimmed()
  .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value), {
    message: 'Use a date such as 2026-08-17.',
  })
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, { message: 'That date does not exist.' });

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

const hoursSchema = (label: string, max: number) =>
  z.coerce
    .number()
    .min(0, { message: `${label} cannot be negative.` })
    .max(max, { message: `${label} must be ${max} hours or fewer.` });

const optionalHoursSchema = (max: number) =>
  z
    .union([z.literal(''), z.coerce.number().min(0).max(max)])
    .transform((value): number | null => (value === '' ? null : value));

/** Kickoff after arrival, end after kickoff — the same rules the table enforces. */
const orderedTimes = (
  value: { arrival_time: string; kickoff_time: string; end_time: string },
  ctx: z.RefinementCtx,
): void => {
  if (value.kickoff_time < value.arrival_time) {
    ctx.addIssue({
      code: 'custom',
      path: ['kickoff_time'],
      message: 'Kickoff cannot be before the arrival time.',
    });
  }
  if (value.end_time <= value.kickoff_time) {
    ctx.addIssue({
      code: 'custom',
      path: ['end_time'],
      message: 'The end time must be after kickoff.',
    });
  }
};

const thresholdWithinCapacity = (
  value: { capacity: number; min_players: number },
  ctx: z.RefinementCtx,
): void => {
  if (value.min_players > value.capacity) {
    ctx.addIssue({
      code: 'custom',
      path: ['min_players'],
      message: 'The minimum cannot exceed the capacity.',
    });
  }
};

const sharedMatchFields = {
  arrival_time: localTimeSchema,
  kickoff_time: localTimeSchema,
  end_time: localTimeSchema,
  location_name: requiredText('Location', 160),
  location_map_url: optionalHttpsUrl(),
  capacity: capacitySchema,
  min_players: minPlayersSchema,
  team_count: teamCountSchema,
};

export const matchTemplateSchema = z
  .object({
    ...sharedMatchFields,
    name: requiredText('Template name', 120),
    day_of_week: z
      .union([z.literal(''), z.coerce.number().int().min(0).max(6)])
      .transform((value): number | null => (value === '' ? null : value)),
    recurrence_note: optionalText(160),
    selection_mode: z.enum(['first_come', 'admin_approval']),
    waitlist_mode: z.enum(['automatic', 'admin_controlled']),
    priority_window_hours: optionalHoursSchema(720),
    signup_closes_before_hours: hoursSchema('Signup close', 720),
    cancellation_cutoff_before_hours: hoursSchema('Cancellation cutoff', 720),
    roster_publish_before_hours: optionalHoursSchema(720),
    is_active: z.boolean(),
  })
  .superRefine(orderedTimes)
  .superRefine(thresholdWithinCapacity);

export const createMatchSchema = z
  .object({
    ...sharedMatchFields,
    title: requiredText('Match title', 160),
    match_date: localDateSchema,
    selection_mode: z.enum(['first_come', 'admin_approval']),
    waitlist_mode: z.enum(['automatic', 'admin_controlled']),
    template_id: z
      .union([z.literal(''), z.uuid()])
      .transform((value): string | null => (value === '' ? null : value)),
    priority_window_hours: optionalHoursSchema(720),
    signup_closes_before_hours: hoursSchema('Signup close', 720),
    cancellation_cutoff_before_hours: hoursSchema('Cancellation cutoff', 720),
    roster_publish_before_hours: optionalHoursSchema(720),
    public_notes: optionalText(2000),
    admin_notes: optionalText(4000),
  })
  .superRefine(orderedTimes)
  .superRefine(thresholdWithinCapacity);

/**
 * The editable subset of a published match.
 *
 * Deliberately narrower than creation: selection mode, waitlist mode and the
 * deadline *rules* are not here. Changing how spots are allocated after members
 * have seen a match would rewrite the terms they responded to, and the
 * deadlines move automatically with kickoff so their lead time is preserved.
 */
export const updatePublishedMatchSchema = z
  .object({
    ...sharedMatchFields,
    title: requiredText('Match title', 160),
    match_date: localDateSchema,
    public_notes: optionalText(2000),
    change_note: optionalText(500),
  })
  .superRefine(orderedTimes)
  .superRefine(thresholdWithinCapacity);

export type MatchTemplateInput = z.infer<typeof matchTemplateSchema>;
export type CreateMatchInput = z.infer<typeof createMatchSchema>;
export type UpdatePublishedMatchInput = z.infer<typeof updatePublishedMatchSchema>;

/** PostgreSQL interval literal, or `null`. Hours are the only unit any form offers. */
export function hoursToInterval(hours: number | null): string | null {
  return hours === null ? null : `${hours} hours`;
}

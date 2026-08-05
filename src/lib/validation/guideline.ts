import { z } from 'zod';

/**
 * Guideline draft validation.
 *
 * Bounds mirror `20260805030000_guidelines.sql`. Note what is absent:
 * `published_at`, `archived_at` and `content_checksum`. Publication and
 * archiving are separate audited operations, and the checksum is derived from
 * the body by a database trigger — a client that could supply one could claim a
 * member accepted text they never saw.
 */

const trimmed = () => z.string().transform((value) => value.trim());

export const guidelineDraftSchema = z.object({
  version_label: trimmed()
    .refine((value) => value.length >= 1, { message: 'A version label is required.' })
    .refine((value) => value.length <= 60, { message: 'Use 60 characters or fewer.' }),

  title: trimmed()
    .refine((value) => value.length >= 1, { message: 'A title is required.' })
    .refine((value) => value.length <= 160, { message: 'Use 160 characters or fewer.' }),

  body: trimmed()
    .refine((value) => value.length >= 1, { message: 'The guidelines cannot be empty.' })
    .refine((value) => value.length <= 100000, { message: 'That text is too long.' }),

  document_url: trimmed()
    .refine((value) => value === '' || /^https:\/\//.test(value), {
      message: 'Use a full https:// address.',
    })
    .refine((value) => value.length <= 2048, { message: 'That address is too long.' })
    .transform((value): string | null => (value === '' ? null : value)),

  requires_acceptance: z.boolean(),

  effective_at: trimmed()
    .refine((value) => value === '' || !Number.isNaN(Date.parse(value)), {
      message: 'Use a valid date.',
    })
    .transform((value): string | null => (value === '' ? null : new Date(value).toISOString())),
});

export type GuidelineDraftInput = z.infer<typeof guidelineDraftSchema>;

/**
 * The acceptance control must be submitted deliberately.
 *
 * 02 §8 requires that acceptance is "explicit and never prechecked". A checkbox
 * that is not ticked submits nothing at all, so this rejects anything other
 * than the exact affirmative value — an empty or absent field is a refusal, not
 * a default.
 */
export const guidelineAcceptanceSchema = z.object({
  guideline_version_id: z.uuid({ message: 'Choose the guidelines to accept.' }),
  confirm: z.literal('accept', {
    message: 'Tick the box to confirm you have read and accept the guidelines.',
  }),
});

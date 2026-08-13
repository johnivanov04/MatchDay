'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireLeagueAdmin } from '@/lib/auth/authorization';
import { actionFailure, actionSuccess, type ActionResult } from '@/lib/errors';
import { domainErrorFromDatabase } from '@/lib/errors-from-database';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Phase 7 attendance actions.
 *
 * Thin, like the Phase 6 team actions: the database function owns the match row
 * lock, the eligibility check against the attendance population, the outcome
 * validation, the revision, the notification and the audit event. Nothing here
 * decides an outcome, and nothing here passes an actor or a league — the
 * database derives both from `auth.uid()`.
 *
 * NO PUSH DISPATCH. Every other fanout action in this codebase calls
 * `dispatchPushForKeyPrefix` after committing. Attendance deliberately does
 * not: `attendance_recorded` is absent from `PUSH_ELIGIBLE_TYPES`, the
 * notification is written with `push_eligible: false`, and 7Q settles that the
 * canonical in-app record is required while an automatic push is not. A push
 * payload renders on a lock screen where anyone glancing at the phone can read
 * it, and "You are recorded as not having attended" is not something to put
 * there without the league asking for it.
 */

const matchIdSchema = z.uuid();
const membershipIdSchema = z.uuid();
const outcomeSchema = z.enum([
  'attended',
  'excused_absence',
  'canceled_on_time',
  'canceled_late',
  'no_show',
]);

/** Administrator-only free text about a person. 1000 characters, matching the column. */
const noteSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length <= 1000, { message: 'Use 1000 characters or fewer.' })
  .transform((value): string | null => (value === '' ? null : value));

/**
 * A revision the form was rendered against, if it carried one.
 *
 * Absent for a first recording. Present for a correction, where it is what
 * makes two administrators editing the same player at once resolve into one
 * refusal rather than one silent overwrite.
 */
const expectedRevisionSchema = z
  .union([z.literal(''), z.coerce.number().int().min(1)])
  .transform((value): number | null => (value === '' ? null : value));

/**
 * Records or corrects one player's attendance.
 *
 * One action for both. They differ only in whether a record already exists, and
 * the unique constraint on `(match_id, membership_id)` is what makes the second
 * one a correction rather than a duplicate.
 */
export async function recordAttendanceAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    await requireLeagueAdmin(leagueId);

    const matchId = matchIdSchema.parse(formData.get('match_id') ?? '');
    const membershipId = membershipIdSchema.parse(formData.get('membership_id') ?? '');
    const outcome = outcomeSchema.parse(formData.get('outcome') ?? '');
    const note = noteSchema.parse(formData.get('note') ?? '');
    const expectedRevision = expectedRevisionSchema.parse(formData.get('expected_revision') ?? '');

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('record_attendance', {
      p_match_id: matchId,
      p_membership_id: membershipId,
      p_outcome: outcome,
      p_note: note,
      p_expected_revision: expectedRevision,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/**
 * Closes the match.
 *
 * The database refuses unless the match has ended and every attendance-eligible
 * participant has an outcome, so `ATTENDANCE_INCOMPLETE` coming back is the
 * normal path rather than an error state — the administrator has not finished
 * yet, and the workspace shows them who is missing.
 */
export async function completeMatchAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    await requireLeagueAdmin(leagueId);

    const matchId = matchIdSchema.parse(formData.get('match_id') ?? '');

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('complete_match', { p_match_id: matchId });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

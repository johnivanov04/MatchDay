import type { AttendanceOutcome } from '@/types/database';

/**
 * How attendance is written and which outcomes are offered.
 *
 * SEPARATE FROM `attendance.ts` ON PURPOSE. That module reads the database and
 * therefore imports the server client, which is `server-only`; the attendance
 * workspace is a client component and needs these labels. Keeping them in one
 * file would pull the server client into the browser bundle, which the build
 * refuses — correctly, since it would be one careless import away from shipping
 * a Supabase server helper to a phone.
 *
 * Everything here is pure and has no dependency beyond the outcome type.
 */

/**
 * How each outcome is written wherever one is shown.
 *
 * Neutral by construction. "Did not attend" rather than "no-show" as the label
 * a player reads, because the same five words appear in the player's own
 * history and a disciplinary vocabulary there would be the product passing
 * judgement — which 04 §1 reserves for the administrator.
 */
export const ATTENDANCE_OUTCOME_LABELS: Record<AttendanceOutcome, string> = {
  attended: 'Attended',
  excused_absence: 'Excused absence',
  canceled_on_time: 'Cancelled on time',
  canceled_late: 'Cancelled late',
  no_show: 'Did not attend',
};

/** The order the outcomes are offered in: most common first, not most severe. */
export const ATTENDANCE_OUTCOMES: readonly AttendanceOutcome[] = [
  'attended',
  'no_show',
  'excused_absence',
  'canceled_on_time',
  'canceled_late',
] as const;

/**
 * Which outcomes make sense for a player in a given signup state.
 *
 * Mirrors the refusals in `record_attendance()` so the interface does not offer
 * a choice the database will reject. It is a convenience, not the rule: the
 * database re-checks every one of these, and a crafted form post is refused
 * there.
 */
export function allowedOutcomes(withdrew: boolean): readonly AttendanceOutcome[] {
  return withdrew
    ? (['canceled_on_time', 'canceled_late', 'excused_absence'] as const)
    : (['attended', 'no_show', 'excused_absence'] as const);
}

import type { BadgeTone } from '@/components/ui/badge';
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

/**
 * The badge tone each outcome is shown in.
 *
 * ── WHY THIS IS NOT A SEVERITY SCALE ───────────────────────────────────────
 *
 * It is the same four-tone vocabulary the rest of the product uses for state —
 * a match is open or cancelled, a membership is active or suspended — applied
 * to a *single recorded fact* about a *single match*. That is deliberately not
 * the same thing as colouring somebody's history: the roster workspace shows
 * attendance counts as a plain sentence with no badge and no colour, because
 * 04 §1 reserves judgement about a person for the administrator, and a red dot
 * against a running total is the product making that judgement instead.
 *
 * Here there is no total to judge. "Did not attend, on this match" is red for
 * the same reason "Canceled" is red on a match card: it is the negative
 * outcome of one event, and it is stated in words beside the colour.
 */
export const ATTENDANCE_OUTCOME_TONES: Record<AttendanceOutcome, BadgeTone> = {
  attended: 'live',
  excused_absence: 'neutral',
  canceled_on_time: 'neutral',
  canceled_late: 'pending',
  no_show: 'off',
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

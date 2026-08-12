import { createSupabaseServerClient } from '@/lib/supabase/server';
import type {
  AttendanceWorkspaceEntry,
  MembershipAttendanceSummary,
  MyAttendance,
  MyAttendanceEntry,
} from '@/types/database';

/**
 * Reading attendance.
 *
 * The administrator's view and the player's view are separate functions rather
 * than one filtered projection, because they differ in a column and not only in
 * rows: the administrator's note is in the workspace and reaches nothing a
 * player can call. Row Level Security cannot express that — it filters rows —
 * so `attendance_records` carries an administrator-only policy and the player
 * routes go through SECURITY DEFINER projections that never select the note.
 */

/** Everybody who was ever confirmed, and whatever is recorded for them. Empty for a player. */
export async function getAttendanceWorkspace(
  matchId: string,
): Promise<AttendanceWorkspaceEntry[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('match_attendance_workspace', {
    p_match_id: matchId,
  });

  return error !== null || data === null ? [] : data;
}

/** Whether the match has finished, so attendance can be recorded at all. */
export async function matchAcceptsAttendance(matchId: string): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('match_accepts_attendance', { p_match_id: matchId });

  return error !== null ? false : data === true;
}

/**
 * The signed-in player's own outcome for one match.
 *
 * There is no parameter for whose attendance to fetch, so asking about somebody
 * else is not expressible here or in the database function underneath.
 */
export async function getMyAttendance(matchId: string): Promise<MyAttendance | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('my_attendance', { p_match_id: matchId });

  return error !== null || data === null ? null : (data[0] ?? null);
}

/** The signed-in player's own attendance across one league, most recent first. */
export async function getMyAttendanceHistory(leagueId: string): Promise<MyAttendanceEntry[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('my_attendance_history', { p_league_id: leagueId });

  return error !== null || data === null ? [] : data;
}

/**
 * No-show context for the roster workspace, keyed by membership.
 *
 * Returns a Map so a caller renders `summaries.get(id)` without scanning, and
 * an absent entry and a zeroed one are the same thing to the template.
 */
export async function getAttendanceSummaries(
  leagueId: string,
  membershipIds: string[],
): Promise<Map<string, MembershipAttendanceSummary>> {
  if (membershipIds.length === 0) {
    return new Map();
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('membership_attendance_summary', {
    p_league_id: leagueId,
    p_membership_ids: membershipIds,
  });

  if (error !== null || data === null) {
    return new Map();
  }

  return new Map(data.map((row) => [row.membership_id, row]));
}

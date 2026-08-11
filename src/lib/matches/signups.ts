import { createSupabaseServerClient } from '@/lib/supabase/server';
import type {
  AddableMember,
  ConfirmedRosterEntry,
  MatchSignupCounts,
  RosterAdminEntry,
  SignupEligibility,
  SignupOutcome,
} from '@/types/database';

/**
 * Reading Phase 4 signup state.
 *
 * Every function here goes through a database projection rather than selecting
 * from `match_signups` and joining `profiles`. That is not indirection for its
 * own sake: `profiles` Row Level Security gives a player no access to another
 * player's row, so a join would silently return a roster missing everyone but
 * the caller. Widening that policy would expose `phone` and `gender` too,
 * because RLS filters rows and not columns — so the projections return names
 * and nothing else, and there is no object here to widen by accident.
 */

/**
 * Why this player can or cannot sign up, as a stable domain code.
 *
 * Returns `MEMBERSHIP_REQUIRED` on any failure to reach the database, which is
 * also the answer for a match that does not exist — the same conservative
 * default the page guards use, so an outage cannot open a signup path.
 */
export async function getSignupEligibility(matchId: string): Promise<SignupEligibility> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('match_signup_eligibility', {
    p_match_id: matchId,
  });

  if (error !== null || data === null) {
    return 'MEMBERSHIP_REQUIRED';
  }

  return data;
}

/** The caller's own signup, or `null` if they have not responded. */
export async function getMySignup(matchId: string): Promise<SignupOutcome | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('my_match_signup', { p_match_id: matchId });

  if (error !== null || data === null) {
    return null;
  }

  // A composite-returning function with no matching row answers with a row of
  // nulls rather than no row at all.
  return data.status === null ? null : data;
}

/** Confirmed players' names, for an active member of the league. */
export async function getConfirmedRoster(matchId: string): Promise<ConfirmedRosterEntry[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('match_confirmed_roster', {
    p_match_id: matchId,
  });

  return error !== null || data === null ? [] : data;
}

/**
 * Counts behind the derived participation label and the open-spot figure.
 *
 * `null` when the caller may not see the match at all, which keeps the caller
 * from having to distinguish "no signups yet" from "not allowed" — the page
 * shows the pre-signup state for both.
 */
export async function getSignupCounts(matchId: string): Promise<MatchSignupCounts | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('match_signup_counts', { p_match_id: matchId });

  if (error !== null || data === null || data.length === 0) {
    return null;
  }

  return data[0] ?? null;
}

/** The administrator workspace. Returns `[]` for anyone else — the function checks. */
export async function getRosterForAdmin(matchId: string): Promise<RosterAdminEntry[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('match_roster_admin', { p_match_id: matchId });

  return error !== null || data === null ? [] : data;
}

/** Active members who have not already been placed on this roster or waitlist. */
export async function getAddableMembers(matchId: string): Promise<AddableMember[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('match_addable_members', { p_match_id: matchId });

  return error !== null || data === null ? [] : data;
}

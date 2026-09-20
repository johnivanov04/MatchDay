import 'server-only';

import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { RosterSafetyRow } from '@/types/database';

/**
 * Who on a match roster the caller can report or block.
 *
 * Separate from the roster itself because `match_confirmed_roster` returns
 * membership ids and deliberately not user ids. Returned as a Map keyed by
 * membership id so the roster render stays a single pass.
 *
 * A caller who cannot see the roster gets an empty map, and so does a match
 * that does not exist — the function answers both identically.
 */
export async function getRosterSafety(matchId: string): Promise<Map<string, RosterSafetyRow>> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.rpc('match_roster_safety', { p_match_id: matchId });

  return new Map(((data ?? []) as RosterSafetyRow[]).map((row) => [row.membership_id, row]));
}

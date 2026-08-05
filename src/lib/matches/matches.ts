import 'server-only';

import { requireLeagueAdmin } from '@/lib/auth/authorization';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { MatchAdminNoteRow, MatchRow, MatchTemplateRow } from '@/types/database';

/**
 * Match and template reads.
 *
 * Draft invisibility is enforced by Row Level Security, not by a filter here:
 * `matches_select_member` requires `published_at is not null`, so the same
 * query returns drafts to an administrator and hides them from everyone else.
 * A mistake in this file cannot leak a draft.
 */

export async function getLeagueMatchTemplates(leagueId: string): Promise<MatchTemplateRow[]> {
  await requireLeagueAdmin(leagueId);
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('match_templates')
    .select('*')
    .eq('league_id', leagueId)
    .order('is_active', { ascending: false })
    .order('day_of_week', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true });

  if (error !== null) {
    return [];
  }

  return data ?? [];
}

export async function getMatchTemplate(
  leagueId: string,
  templateId: string,
): Promise<MatchTemplateRow | null> {
  await requireLeagueAdmin(leagueId);
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('match_templates')
    .select('*')
    .eq('id', templateId)
    .eq('league_id', leagueId)
    .maybeSingle();

  if (error !== null) {
    return null;
  }

  return data;
}

/** Upcoming matches, ordered by kickoff. Whether drafts appear depends on the caller. */
export async function getUpcomingMatches(leagueId: string): Promise<MatchRow[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .eq('league_id', leagueId)
    .gte('kickoff_at', new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString())
    .order('kickoff_at', { ascending: true })
    .limit(50);

  if (error !== null) {
    return [];
  }

  return data ?? [];
}

/** Recently finished or cancelled matches, for context under the upcoming list. */
export async function getPastMatches(leagueId: string): Promise<MatchRow[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .eq('league_id', leagueId)
    .lt('kickoff_at', new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString())
    .order('kickoff_at', { ascending: false })
    .limit(20);

  if (error !== null) {
    return [];
  }

  return data ?? [];
}

/**
 * One match, or `null`.
 *
 * `null` covers three cases that are deliberately indistinguishable from
 * outside: the match does not exist, it belongs to another league, or it is a
 * draft the caller may not see. Pages turn this into a redirect, never an
 * error, so a guessed identifier reveals nothing.
 */
export async function getMatch(leagueId: string, matchId: string): Promise<MatchRow | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .eq('id', matchId)
    .eq('league_id', leagueId)
    .maybeSingle();

  if (error !== null) {
    return null;
  }

  return data;
}

/** Administrator notes for a match. Returns `null` for anyone else — the RLS does the work. */
export async function getMatchAdminNotes(
  leagueId: string,
  matchId: string,
): Promise<MatchAdminNoteRow | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('match_admin_notes')
    .select('*')
    .eq('match_id', matchId)
    .eq('league_id', leagueId)
    .maybeSingle();

  if (error !== null) {
    return null;
  }

  return data;
}

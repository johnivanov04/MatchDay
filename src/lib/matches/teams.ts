import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { DraftTeam, PublishedTeamEntry, TeamBuilderPlayer } from '@/types/database';

/**
 * Reading team state.
 *
 * The draft and the published snapshot are read through different functions on
 * purpose. `match_teams` and `match_team_assignments` carry administrator-only
 * policies, so a player querying them gets nothing at all — an unpublished team
 * cannot leak through a projection here because there is no projection here
 * that could reach it.
 */

/** The administrator's draft teams. Empty for anybody else. */
export async function getDraftTeams(matchId: string): Promise<DraftTeam[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('match_draft_teams', { p_match_id: matchId });

  return error !== null || data === null ? [] : data;
}

/** Every confirmed player and their draft team, with the permitted indicators. */
export async function getTeamBuilderPlayers(matchId: string): Promise<TeamBuilderPlayer[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('match_team_builder', { p_match_id: matchId });

  return error !== null || data === null ? [] : data;
}

/**
 * The published teams, for a confirmed player.
 *
 * Empty for everybody else — including somebody who was on a team and has since
 * cancelled, since the projection filters to players who are *currently*
 * confirmed. That is also what stops a cancellation leaving a stale name on a
 * published team between the withdrawal and the administrator noticing.
 */
export async function getPublishedTeams(matchId: string): Promise<PublishedTeamEntry[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('match_published_teams', { p_match_id: matchId });

  return error !== null || data === null ? [] : data;
}

export interface PublishedTeamGroup {
  name: string;
  label: string | null;
  displayOrder: number;
  players: PublishedTeamEntry[];
}

/** Groups the flat projection into teams, preserving the published order. */
export function groupPublishedTeams(entries: PublishedTeamEntry[]): PublishedTeamGroup[] {
  const groups = new Map<number, PublishedTeamGroup>();

  for (const entry of entries) {
    const existing = groups.get(entry.display_order);
    if (existing === undefined) {
      groups.set(entry.display_order, {
        name: entry.team_name,
        label: entry.team_label,
        displayOrder: entry.display_order,
        players: [entry],
      });
    } else {
      existing.players.push(entry);
    }
  }

  return [...groups.values()].sort((a, b) => a.displayOrder - b.displayOrder);
}

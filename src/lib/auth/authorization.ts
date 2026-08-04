import 'server-only';

import { cache } from 'react';
import { DomainError } from '@/lib/errors';
import { requireSessionUser } from '@/lib/auth/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { LeagueMembershipRow, LeagueRow } from '@/types/database';

/** A membership together with the league it belongs to. */
export interface LeagueMembershipWithLeague {
  membership: LeagueMembershipRow;
  league: LeagueRow;
}

/**
 * Every league relationship the current user holds, across all tenants.
 *
 * Note what this function does *not* accept: a user ID. The actor comes from
 * the verified session and nowhere else, so no caller can ask for someone
 * else's memberships (engineering requirement 3). Row Level Security enforces
 * the same restriction underneath, independently.
 */
export const getMyMemberships = cache(async (): Promise<LeagueMembershipWithLeague[]> => {
  const user = await requireSessionUser();
  const supabase = await createSupabaseServerClient();

  const { data: memberships, error: membershipError } = await supabase
    .from('league_memberships')
    .select('*')
    .eq('user_id', user.id)
    .neq('status', 'removed')
    .order('created_at', { ascending: true });

  if (membershipError !== null || memberships === null || memberships.length === 0) {
    return [];
  }

  const leagueIds = memberships.map((membership) => membership.league_id);
  const { data: leagues, error: leagueError } = await supabase
    .from('leagues')
    .select('*')
    .in('id', leagueIds);

  if (leagueError !== null || leagues === null) {
    return [];
  }

  const leaguesById = new Map(leagues.map((league) => [league.id, league]));

  return memberships.flatMap((membership) => {
    const league = leaguesById.get(membership.league_id);
    // A membership whose league RLS will not return is dropped rather than
    // rendered with placeholder data.
    return league === undefined ? [] : [{ membership, league }];
  });
});

/** The current user's relationship with one league, or `null`. */
export async function getMyMembership(
  leagueId: string,
): Promise<LeagueMembershipWithLeague | null> {
  const memberships = await getMyMemberships();
  return memberships.find((entry) => entry.league.id === leagueId) ?? null;
}

/**
 * Asserts the current user is an active member of `leagueId`.
 *
 * `MEMBERSHIP_REQUIRED` and `MEMBERSHIP_INACTIVE` are distinguished because
 * the user already knows which leagues they belong to — neither answer reveals
 * anything about a tenant they cannot see. For a league they have no
 * relationship with at all, the answer is always `MEMBERSHIP_REQUIRED`,
 * whether or not that league exists.
 */
export async function requireActiveMembership(
  leagueId: string,
): Promise<LeagueMembershipWithLeague> {
  const entry = await getMyMembership(leagueId);

  if (entry === null) {
    throw new DomainError('MEMBERSHIP_REQUIRED');
  }
  if (entry.membership.status !== 'active') {
    throw new DomainError('MEMBERSHIP_INACTIVE');
  }

  return entry;
}

/** Asserts the current user is the active administrator of `leagueId`. */
export async function requireLeagueAdmin(leagueId: string): Promise<LeagueMembershipWithLeague> {
  const entry = await requireActiveMembership(leagueId);

  if (entry.membership.role !== 'league_admin') {
    throw new DomainError('NOT_LEAGUE_ADMIN');
  }

  return entry;
}

/** Non-throwing form, for deciding what to render. Never for deciding access. */
export async function isLeagueAdmin(leagueId: string): Promise<boolean> {
  const entry = await getMyMembership(leagueId);
  return entry !== null && entry.membership.status === 'active' && entry.membership.role === 'league_admin';
}

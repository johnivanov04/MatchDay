import 'server-only';

import { cache } from 'react';
import { getMyMemberships, type LeagueMembershipWithLeague } from '@/lib/auth/authorization';
import { requireSessionUser } from '@/lib/auth/session';
import { DomainError } from '@/lib/errors';
import {
  buildLeagueSwitcherModel,
  resolveActiveMembership,
  type LeagueSwitcherModel,
} from '@/lib/leagues/league-context';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export interface LeagueContext {
  /** The league currently being viewed, or `null` when the user has no active membership. */
  active: LeagueMembershipWithLeague | null;
  switcher: LeagueSwitcherModel;
}

/**
 * Resolves the league context for the current request.
 *
 * The stored preference is a *hint*. It is re-checked against live memberships
 * on every request, so a membership that has since been suspended or removed
 * cannot leave a working context behind.
 */
export const getLeagueContext = cache(async (): Promise<LeagueContext> => {
  const user = await requireSessionUser();
  const supabase = await createSupabaseServerClient();

  const [memberships, storedState] = await Promise.all([
    getMyMemberships(),
    supabase.from('user_app_state').select('active_league_id').eq('user_id', user.id).maybeSingle(),
  ]);

  const storedActiveLeagueId = storedState.data?.active_league_id ?? null;

  return {
    active: resolveActiveMembership(memberships, storedActiveLeagueId),
    switcher: buildLeagueSwitcherModel(memberships),
  };
});

/**
 * Persists the user's active league.
 *
 * `leagueId` arrives from the client and is therefore treated as untrusted: the
 * membership is re-derived from the session before anything is written, and the
 * database repeats the check independently in
 * `user_app_state_validate_active_league`. A forged league ID fails twice.
 */
export async function setActiveLeague(leagueId: string): Promise<void> {
  const user = await requireSessionUser();

  const memberships = await getMyMemberships();
  const target = memberships.find((entry) => entry.league.id === leagueId);

  if (target === undefined) {
    throw new DomainError('MEMBERSHIP_REQUIRED');
  }
  if (target.membership.status !== 'active') {
    throw new DomainError('MEMBERSHIP_INACTIVE');
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('user_app_state')
    .upsert({ user_id: user.id, active_league_id: leagueId }, { onConflict: 'user_id' });

  if (error !== null) {
    throw new DomainError('NOT_AUTHORIZED', { cause: error });
  }
}

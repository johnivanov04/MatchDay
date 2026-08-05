import 'server-only';

import {
  getMyMemberships,
  requireLeagueAdmin,
  type LeagueMembershipWithLeague,
} from '@/lib/auth/authorization';
import { requireSessionUser } from '@/lib/auth/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type {
  LeagueInviteRow,
  LeagueJoinRequestRow,
  LeagueMembershipRow,
  ProfileRow,
} from '@/types/database';

/**
 * Administrator-side reads for a single league.
 *
 * Each function starts from `requireLeagueAdmin(leagueId)`, so the actor is the
 * session user and the tenant is re-derived rather than accepted. Row Level
 * Security enforces the same boundary underneath: even if a check here were
 * removed, `league_join_requests` and `league_invites` return zero rows to a
 * non-administrator.
 */

/**
 * Resolves a slug to the caller's own membership of that league, or `null`.
 *
 * Non-throwing on purpose. Page guards need to turn "no such league for you"
 * into a redirect, and a thrown `DomainError` during a render is reported by
 * Next.js as an unhandled application error — see the note at the top of
 * `@/lib/auth/page-guards`. Slugs are not secrets; memberships are.
 */
export async function findMyLeagueBySlug(
  slug: string,
): Promise<LeagueMembershipWithLeague | null> {
  const memberships = await getMyMemberships();
  return memberships.find((entry) => entry.league.slug === slug) ?? null;
}

export interface LeagueMemberSummary {
  membership: LeagueMembershipRow;
  /** Only the fields an administrator needs to manage membership. */
  profile: Pick<ProfileRow, 'id' | 'first_name' | 'last_name' | 'email_normalized'> | null;
}

/**
 * Every membership in the league, with just enough profile to identify a
 * person.
 *
 * Phone, gender, goalkeeper willingness and photo are deliberately not
 * selected. An administrator may read them under Phase 1's
 * `profiles_select_league_admin` policy, but the member-management screen has
 * no use for them, and not fetching them is what keeps them out of the RSC
 * payload.
 */
export async function getLeagueMembers(leagueId: string): Promise<LeagueMemberSummary[]> {
  await requireLeagueAdmin(leagueId);
  const supabase = await createSupabaseServerClient();

  const { data: memberships, error } = await supabase
    .from('league_memberships')
    .select('*')
    .eq('league_id', leagueId)
    .order('role', { ascending: true })
    .order('created_at', { ascending: true });

  if (error !== null || memberships === null) {
    return [];
  }

  const userIds = memberships.map((membership) => membership.user_id);
  if (userIds.length === 0) {
    return [];
  }

  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, email_normalized')
    .in('id', userIds);

  const profilesById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));

  return memberships.map((membership) => ({
    membership,
    profile: profilesById.get(membership.user_id) ?? null,
  }));
}

export interface JoinRequestSummary {
  request: LeagueJoinRequestRow;
  profile: Pick<ProfileRow, 'id' | 'first_name' | 'last_name' | 'email_normalized'> | null;
}

/** Pending join requests for the league, oldest first. */
export async function getPendingJoinRequests(leagueId: string): Promise<JoinRequestSummary[]> {
  await requireLeagueAdmin(leagueId);
  const supabase = await createSupabaseServerClient();

  const { data: requests, error } = await supabase
    .from('league_join_requests')
    .select('*')
    .eq('league_id', leagueId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error !== null || requests === null || requests.length === 0) {
    return [];
  }

  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, email_normalized')
    .in(
      'id',
      requests.map((request) => request.user_id),
    );

  const profilesById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));

  return requests.map((request) => ({
    request,
    profile: profilesById.get(request.user_id) ?? null,
  }));
}

/**
 * Invitations for the league.
 *
 * The column list omits `token_hash` — and must, because `authenticated` has no
 * privilege on it. A raw token is never recoverable after creation; the UI
 * shows it once, at that moment, and nowhere else.
 */
export async function getLeagueInvites(leagueId: string): Promise<LeagueInviteRow[]> {
  await requireLeagueAdmin(leagueId);
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('league_invites')
    .select(
      'id, league_id, label, grants_status, max_uses, use_count, expires_at, revoked_at, created_by, created_at, updated_at',
    )
    .eq('league_id', leagueId)
    .order('created_at', { ascending: false });

  if (error !== null || data === null) {
    return [];
  }

  return data;
}

export type InviteState = 'live' | 'revoked' | 'expired' | 'exhausted';

export interface InviteWithState {
  invite: LeagueInviteRow;
  state: InviteState;
}

/**
 * Classifies an invitation against the current time.
 *
 * Done on the server, not in the component: reading the clock during a render
 * is impure, and a client-side comparison would also disagree with the server
 * whenever the two machines' clocks differ. This is presentation only — the
 * authoritative decision is inside `redeem_league_invite()`.
 */
export function describeInvite(invite: LeagueInviteRow, now: Date = new Date()): InviteState {
  if (invite.revoked_at !== null) return 'revoked';
  if (new Date(invite.expires_at).getTime() <= now.getTime()) return 'expired';
  if (invite.max_uses !== null && invite.use_count >= invite.max_uses) return 'exhausted';
  return 'live';
}

export interface MyJoinRequest {
  request: LeagueJoinRequestRow;
  leagueName: string | null;
}

/**
 * The caller's own join requests, for showing "awaiting approval" on the
 * discovery page. Reads only the public projection for the league name, so a
 * pending applicant learns nothing beyond what search already showed them.
 */
export async function getMyPendingJoinRequests(): Promise<MyJoinRequest[]> {
  const user = await requireSessionUser();
  const supabase = await createSupabaseServerClient();

  const { data: requests, error } = await supabase
    .from('league_join_requests')
    .select('*')
    .eq('user_id', user.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error !== null || requests === null || requests.length === 0) {
    return [];
  }

  const { data: leagues } = await supabase
    .from('searchable_leagues_public')
    .select('id, name')
    .in(
      'id',
      requests.map((request) => request.league_id),
    );

  const namesById = new Map((leagues ?? []).map((league) => [league.id, league.name]));

  return requests.map((request) => ({
    request,
    leagueName: namesById.get(request.league_id) ?? null,
  }));
}

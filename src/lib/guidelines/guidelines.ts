import 'server-only';

import { requireLeagueAdmin } from '@/lib/auth/authorization';
import { requireSessionUser } from '@/lib/auth/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { GuidelineVersionRow } from '@/types/database';

/**
 * Guideline reads.
 *
 * Every function here relies on Row Level Security for the boundary rather than
 * filtering by hand: members receive published versions, administrators receive
 * drafts as well, and a non-member receives nothing — from the same query.
 */

export async function getLeagueGuidelineVersions(
  leagueId: string,
): Promise<GuidelineVersionRow[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('guideline_versions')
    .select('*')
    .eq('league_id', leagueId)
    .order('effective_at', { ascending: false })
    .order('created_at', { ascending: false });

  if (error !== null) {
    return [];
  }

  return data ?? [];
}

export interface MemberGuidelineView {
  /** The version that must be accepted before signing up, if any. */
  required: GuidelineVersionRow | null;
  /** Every published version, newest first — including archived history. */
  published: GuidelineVersionRow[];
  /** Whether the caller has accepted `required`. Meaningless when it is null. */
  accepted: boolean;
  acceptedVersionIds: Set<string>;
}

/**
 * What a member sees on the guidelines page.
 *
 * `accepted` comes from the database predicate rather than being recomputed
 * here, so the page and Phase 4's signup gate can never disagree about whether
 * somebody is eligible.
 *
 * A failure to read it **throws** rather than defaulting to `false`. Reporting
 * "you have not accepted" when the truth is "the database did not answer" would
 * be a lie that blocks a member from playing, and — once Phase 4 wires the same
 * predicate into signup — an outage that silently locks every league out of
 * every match.
 */
export async function getMemberGuidelineView(leagueId: string): Promise<MemberGuidelineView> {
  const user = await requireSessionUser();
  const supabase = await createSupabaseServerClient();

  const [versionsResult, requiredResult, acceptedResult, acceptancesResult] = await Promise.all([
    supabase
      .from('guideline_versions')
      .select('*')
      .eq('league_id', leagueId)
      .not('published_at', 'is', null)
      .order('effective_at', { ascending: false }),
    supabase.rpc('current_required_guideline_version', { p_league_id: leagueId }),
    supabase.rpc('has_accepted_required_guidelines', { p_league_id: leagueId }),
    supabase
      .from('guideline_acceptances')
      .select('guideline_version_id')
      .eq('league_id', leagueId),
  ]);

  if (requiredResult.error !== null) {
    throw new Error(
      `Failed to resolve the required guideline version: ${requiredResult.error.message}`,
      { cause: requiredResult.error },
    );
  }
  if (acceptedResult.error !== null) {
    throw new Error(
      `Failed to resolve guideline acceptance: ${acceptedResult.error.message}`,
      { cause: acceptedResult.error },
    );
  }

  const published = versionsResult.data ?? [];
  const requiredId = requiredResult.data;

  void user;

  return {
    required: requiredId === null ? null : (published.find((v) => v.id === requiredId) ?? null),
    published,
    accepted: acceptedResult.data === true,
    acceptedVersionIds: new Set(
      (acceptancesResult.data ?? []).map((row) => row.guideline_version_id),
    ),
  };
}

export interface GuidelineAcceptanceStatusRow {
  membership_id: string;
  user_id: string;
  membership_status: string;
  required_version_id: string | null;
  accepted: boolean;
  accepted_at: string | null;
}

/**
 * Who has and has not accepted, for the administrator.
 *
 * Goes through the SECURITY DEFINER function, which re-checks administration of
 * this exact league. There is no variant that answers about a single named
 * member: that would be an oracle for whether an arbitrary person belongs to an
 * arbitrary league.
 */
export async function getGuidelineAcceptanceStatus(
  leagueId: string,
): Promise<GuidelineAcceptanceStatusRow[]> {
  await requireLeagueAdmin(leagueId);
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('league_guideline_acceptance_status', {
    p_league_id: leagueId,
  });

  if (error !== null) {
    throw new Error(`Failed to load acceptance status: ${error.message}`, { cause: error });
  }

  return (data ?? []) as unknown as GuidelineAcceptanceStatusRow[];
}

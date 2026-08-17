import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { RosterWorkspace } from '@/components/roster-workspace';
import {
  dashboardPathWithNotice,
  DASHBOARD_NOTICES,
  matchPath,
  requireLeagueAdminPage,
} from '@/lib/auth/page-guards';
import { getAttendanceSummaries } from '@/lib/matches/attendance';
import { getMatch } from '@/lib/matches/matches';
import {
  getAddableMembers,
  getReplacementState,
  getRosterForAdmin,
} from '@/lib/matches/signups';
import {
  deriveMatchParticipationState,
  participationStateLabel,
} from '@/lib/matches/threshold-state';
import { UsersIcon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Roster' };

/**
 * Administrator-only roster workspace.
 *
 * The guards are the Phase 2/3B pattern and every failure is a redirect: an
 * ordinary error escaping a Server Component is reported by Next.js as an
 * unhandled application error, which is what a player following a shared link
 * would otherwise see.
 *
 * `getMatch` returning `null` covers "does not exist", "belongs to another
 * league" and "is a draft you cannot see" identically, so guessing an id
 * reveals nothing about whether a private match exists.
 */
export default async function MatchRosterPage({
  params,
}: {
  params: Promise<{ slug: string; matchId: string }>;
}) {
  const { slug, matchId } = await params;
  const { league } = await requireLeagueAdminPage(slug);

  const match = await getMatch(league.id, matchId);
  if (match === null) {
    redirect(dashboardPathWithNotice(DASHBOARD_NOTICES.notLeagueAdmin));
  }

  const [entries, addableMembers, replacement] = await Promise.all([
    getRosterForAdmin(matchId),
    getAddableMembers(matchId),
    getReplacementState(matchId),
  ]);

  // No-show context for exactly the people on this screen, and nobody else.
  // Fetched after the roster because the membership ids come from it; the
  // database refuses the whole call for anyone but this league's administrator.
  const summaries = await getAttendanceSummaries(
    league.id,
    entries.map((entry) => entry.membership_id),
  );

  const confirmed = entries.filter((entry) => entry.status === 'confirmed').length;
  const state = deriveMatchParticipationState({
    confirmed,
    capacity: match.capacity,
    minPlayers: match.min_players,
  });

  return (
    <>
      <PageHeader
        eyebrow={league.name}
        icon={<UsersIcon size={13} />}
        title="Roster"
        description={`${match.title} · ${participationStateLabel(state)}`}
        back={{ href: matchPath(slug, matchId), label: 'Back to the match' }}
      />

      {match.status === 'canceled' ? (
        <p
          role="status"
          className="rounded-lg border border-whistle-200 bg-whistle-50 px-3 py-2 text-sm text-red-800 dark:border-whistle-900 dark:bg-whistle-900/25 dark:text-red-200"
        >
          This match was canceled. The roster is shown for reference only.
        </p>
      ) : (
        <RosterWorkspace
          leagueId={league.id}
          matchId={match.id}
          entries={entries}
          attendanceSummaries={Object.fromEntries(summaries)}
          addableMembers={addableMembers}
          capacity={match.capacity}
          rosterRevision={match.roster_revision}
          finalizedAt={match.roster_finalized_at}
          replacement={replacement}
        />
      )}
    </>
  );
}

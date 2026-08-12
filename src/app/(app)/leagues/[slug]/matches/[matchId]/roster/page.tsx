import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { RosterWorkspace } from '@/components/roster-workspace';
import {
  dashboardPathWithNotice,
  DASHBOARD_NOTICES,
  matchPath,
  requireLeagueAdminPage,
} from '@/lib/auth/page-guards';
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

  const confirmed = entries.filter((entry) => entry.status === 'confirmed').length;
  const state = deriveMatchParticipationState({
    confirmed,
    capacity: match.capacity,
    minPlayers: match.min_players,
  });

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-muted">{league.name}</p>
        <h1 className="text-2xl font-bold">Roster</h1>
        <p className="text-sm text-muted">
          {match.title} · {participationStateLabel(state)}
        </p>
        <Link href={matchPath(slug, matchId)} className="mt-1 text-sm underline underline-offset-4">
          Back to the match
        </Link>
      </header>

      {match.status === 'canceled' ? (
        <p
          role="status"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200"
        >
          This match was canceled. The roster is shown for reference only.
        </p>
      ) : (
        <RosterWorkspace
          leagueId={league.id}
          matchId={match.id}
          entries={entries}
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

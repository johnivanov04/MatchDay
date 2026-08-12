import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { TeamBuilder } from '@/components/team-builder';
import { StartTeamsButton } from '@/components/team-builder-start';
import {
  dashboardPathWithNotice,
  DASHBOARD_NOTICES,
  matchPath,
  requireLeagueAdminPage,
} from '@/lib/auth/page-guards';
import { getMatch } from '@/lib/matches/matches';
import { getDraftTeams, getTeamBuilderPlayers } from '@/lib/matches/teams';

export const metadata: Metadata = { title: 'Teams' };

/**
 * Administrator-only team builder.
 *
 * The guards are the pattern Phases 2–5 settled on and every failure is a
 * redirect: an ordinary error escaping a Server Component is reported by
 * Next.js as an unhandled application error, which is what a player following a
 * shared link would otherwise see.
 *
 * `getMatch` returning `null` covers "does not exist", "belongs to another
 * league" and "is a draft you cannot see" identically, so guessing an id
 * reveals nothing.
 */
export default async function MatchTeamsPage({
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

  const [teams, players] = await Promise.all([
    getDraftTeams(matchId),
    getTeamBuilderPlayers(matchId),
  ]);

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-muted">{league.name}</p>
        <h1 className="text-2xl font-bold">Teams</h1>
        <p className="text-sm text-muted">{match.title}</p>
        <Link href={matchPath(slug, matchId)} className="mt-1 text-sm underline underline-offset-4">
          Back to the match
        </Link>
      </header>

      {match.status === 'canceled' ? (
        <p
          role="status"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200"
        >
          This match was canceled. Teams are shown for reference only.
        </p>
      ) : teams.length === 0 ? (
        // Nothing exists yet, so offer to create the match's configured number
        // of teams rather than silently creating them on a GET.
        <section className="surface-card p-4">
          <p className="text-sm text-muted">
            No teams yet. This match is configured for {match.team_count} teams.
          </p>
          <StartTeamsButton leagueId={league.id} matchId={matchId} />
        </section>
      ) : (
        <TeamBuilder
          leagueId={league.id}
          matchId={match.id}
          teams={teams}
          players={players}
          teamRevision={match.team_revision}
          publishedAt={match.teams_published_at}
        />
      )}
    </>
  );
}

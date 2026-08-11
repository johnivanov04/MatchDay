import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  EditDraftMatchForm,
  EditOpenMatchForm,
  MatchAdminNotesForm,
} from '@/components/edit-match';
import {
  dashboardPathWithNotice,
  DASHBOARD_NOTICES,
  MATCH_NOTICES,
  matchPath,
  matchPathWithNotice,
  requireLeagueAdminPage,
} from '@/lib/auth/page-guards';
import { matchCoreDefaults, matchPolicyDefaults } from '@/lib/matches/match-form-defaults';
import { matchEditMode } from '@/lib/matches/match-permissions';
import { getMatch, getMatchAdminNotes } from '@/lib/matches/matches';

export const metadata: Metadata = { title: 'Edit match' };

/**
 * Administrator-only match editing.
 *
 * Three guards, in order, and every failure is a redirect rather than a thrown
 * error — an ordinary error escaping a Server Component is reported by Next.js
 * as an unhandled application error, which is what a player following a stale
 * link would otherwise see.
 *
 * 1. `requireLeagueAdminPage` — players, non-members and administrators of
 *    another league all land on the dashboard with the same notice.
 * 2. `getMatch` returning `null` — covers "does not exist", "belongs to another
 *    league" and "is a draft you cannot see" identically, so guessing an id
 *    reveals nothing about whether a private match exists.
 * 3. A canceled match is read-only in this phase, so it redirects back to its
 *    own detail page rather than offering a form that cannot be saved.
 */
export default async function EditMatchPage({
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

  const mode = matchEditMode(match.status);
  if (mode === null) {
    redirect(matchPathWithNotice(slug, matchId, MATCH_NOTICES.notEditable));
  }

  const adminNotes = await getMatchAdminNotes(league.id, matchId);
  const core = matchCoreDefaults(match);

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-muted">{league.name}</p>
        <h1 className="text-2xl font-bold">Edit match</h1>
        <Link href={matchPath(slug, matchId)} className="mt-1 text-sm underline underline-offset-4">
          Back to the match
        </Link>
      </header>

      {mode === 'draft' ? (
        <EditDraftMatchForm
          leagueId={league.id}
          leagueSlug={slug}
          matchId={match.id}
          timezone={match.timezone}
          core={core}
          policy={matchPolicyDefaults(match)}
        />
      ) : (
        <EditOpenMatchForm
          leagueId={league.id}
          leagueSlug={slug}
          matchId={match.id}
          timezone={match.timezone}
          core={core}
          revision={match.revision}
        />
      )}

      <section className="surface-card flex flex-col gap-3 p-4">
        <h2 className="text-base font-semibold">Administrator notes</h2>
        <MatchAdminNotesForm
          leagueId={league.id}
          leagueSlug={slug}
          matchId={match.id}
          notes={adminNotes?.notes ?? ''}
        />
      </section>
    </>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { requireLeagueMemberPage } from '@/lib/auth/page-guards';
import { formatMatchTime } from '@/lib/matches/match-timing';
import { getPastMatches, getUpcomingMatches } from '@/lib/matches/matches';
import {
  deriveMatchParticipationState,
  participationStateLabel,
} from '@/lib/matches/threshold-state';
import type { MatchRow } from '@/types/database';

export const metadata: Metadata = { title: 'Matches' };

function MatchCard({ match, slug }: { match: MatchRow; slug: string }) {
  // No signup rows exist until Phase 4, so there is no count to judge. The
  // helper says so explicitly rather than deriving a label from a fabricated
  // zero.
  const state = deriveMatchParticipationState(null);
  const canceled = match.status === 'canceled';
  const draft = match.status === 'draft';

  return (
    <li className={`surface-card flex flex-col gap-2 p-4 ${canceled ? 'opacity-70' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <Link
            href={`/leagues/${slug}/matches/${match.id}`}
            className="text-base font-semibold underline-offset-4 hover:underline"
          >
            {match.title}
          </Link>
          <p className="text-sm text-muted">
            {formatMatchTime(new Date(match.kickoff_at), match.timezone)}
          </p>
          <p className="text-sm text-muted">{match.location_name}</p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${
            canceled
              ? 'border-red-400 text-red-700 dark:text-red-300'
              : draft
                ? 'border-[var(--border-subtle)] text-muted'
                : 'border-pitch-500/50'
          }`}
        >
          {canceled ? 'Canceled' : draft ? 'Draft' : 'Open'}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="uppercase tracking-wide text-muted">Capacity</dt>
          <dd className="font-semibold">{match.capacity} players</dd>
        </div>
        <div>
          <dt className="uppercase tracking-wide text-muted">Minimum</dt>
          <dd className="font-semibold">{match.min_players} players</dd>
        </div>
      </dl>

      {canceled ? null : (
        <p className="text-xs text-muted">{participationStateLabel(state)}</p>
      )}
    </li>
  );
}

export default async function LeagueMatchesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { league, isAdmin } = await requireLeagueMemberPage(slug);

  // Drafts appear here only for an administrator, and only because Row Level
  // Security returns them — the query is identical for everyone.
  const [upcoming, past] = await Promise.all([
    getUpcomingMatches(league.id),
    getPastMatches(league.id),
  ]);

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-muted">{league.name}</p>
        <h1 className="text-2xl font-bold">Matches</h1>
        {isAdmin ? (
          <div className="mt-1 flex gap-4 text-sm">
            <Link
              href={`/leagues/${league.slug}/matches/new`}
              className="font-semibold underline underline-offset-4"
            >
              Create a match
            </Link>
            <Link
              href={`/leagues/${league.slug}/templates`}
              className="font-semibold underline underline-offset-4"
            >
              Templates
            </Link>
          </div>
        ) : null}
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">Upcoming</h2>
        {upcoming.length === 0 ? (
          <p className="text-sm text-muted">No upcoming matches yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {upcoming.map((match) => (
              <MatchCard key={match.id} match={match} slug={league.slug} />
            ))}
          </ul>
        )}
      </section>

      {past.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">Recent</h2>
          <ul className="flex flex-col gap-3">
            {past.map((match) => (
              <MatchCard key={match.id} match={match} slug={league.slug} />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

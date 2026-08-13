import type { Metadata } from 'next';
import Link from 'next/link';
import { requireLeagueMemberPage } from '@/lib/auth/page-guards';
import { getMyAttendanceHistory } from '@/lib/matches/attendance';
import { ATTENDANCE_OUTCOME_LABELS } from '@/lib/matches/attendance-display';
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
  const [upcoming, past, attendance] = await Promise.all([
    getUpcomingMatches(league.id),
    getPastMatches(league.id),
    // The caller's own attendance in this league, and nobody else's. The
    // function takes no membership parameter, so asking about somebody else is
    // not expressible, and the administrator's note is not in its signature.
    getMyAttendanceHistory(league.id),
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

      {/*
        The caller's own attendance record.
        
        A plain list, most recent first. There is deliberately no total, no
        percentage, no streak and no comparison with anybody else: a player
        seeing "you have attended 62% of matches" invites them to read a
        judgement into a number the product never intended as one, and 04 §1
        keeps judgement with the administrator.
      */}
      {attendance.length === 0 ? null : (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">Your attendance</h2>
          <ul className="surface-card flex flex-col divide-y divide-[var(--border-subtle)] p-4">
            {attendance.map((entry) => (
              <li
                key={entry.match_id}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2 first:pt-0 last:pb-0"
              >
                <Link
                  href={`/leagues/${league.slug}/matches/${entry.match_id}`}
                  className="text-sm underline underline-offset-4"
                >
                  {entry.match_title}
                </Link>
                <span className="text-xs text-muted">
                  {new Date(entry.kickoff_at).toLocaleDateString('en-GB', {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                  })}{' '}
                  · {ATTENDANCE_OUTCOME_LABELS[entry.outcome]}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">
            Recorded by your league administrator. If something looks wrong, speak to them and they
            can correct it.
          </p>
        </section>
      )}
    </>
  );
}

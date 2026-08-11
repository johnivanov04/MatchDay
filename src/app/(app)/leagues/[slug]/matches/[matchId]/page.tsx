import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CancelMatchForm, PublishMatchButton } from '@/components/matches';
import {
  dashboardPathWithNotice,
  DASHBOARD_NOTICES,
  MATCH_NOTICES,
  parseMatchNotice,
  requireLeagueMemberPage,
  type MatchNotice,
} from '@/lib/auth/page-guards';
import { formatMatchDate, formatMatchTime } from '@/lib/matches/match-timing';
import { getMatch, getMatchAdminNotes } from '@/lib/matches/matches';
import { canEditMatch } from '@/lib/matches/match-permissions';
import {
  deriveMatchParticipationState,
  participationStateLabel,
} from '@/lib/matches/threshold-state';

export const metadata: Metadata = { title: 'Match' };

/**
 * Match detail, and the deep-link target for every match notification.
 *
 * A match the caller may not see returns `null` from `getMatch` — whether it is
 * a draft, belongs to another league, or does not exist — and all three produce
 * the same redirect. Guessing identifiers reveals nothing, and a member removed
 * after a notification was sent cannot follow the old link.
 */
/** Shown after a redirect from the edit form. Display only — nothing is authorized from it. */
const NOTICE_MESSAGES: Record<MatchNotice, string> = {
  [MATCH_NOTICES.saved]: 'Match saved.',
  [MATCH_NOTICES.notesSaved]: 'Notes saved. Members were not notified.',
  [MATCH_NOTICES.notEditable]: 'A canceled match cannot be edited.',
};

export default async function MatchDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; matchId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, matchId } = await params;
  const { league, isAdmin } = await requireLeagueMemberPage(slug);

  const match = await getMatch(league.id, matchId);
  if (match === null) {
    redirect(dashboardPathWithNotice(DASHBOARD_NOTICES.notLeagueMember));
  }

  const notice = parseMatchNotice((await searchParams)['notice']);
  const adminNotes = isAdmin ? await getMatchAdminNotes(league.id, matchId) : null;
  const state = deriveMatchParticipationState(null);

  // Shared with the edit route, so the button and the form cannot disagree
  // about who may edit what.
  const canEdit = canEditMatch(isAdmin, match.status);

  const kickoff = new Date(match.kickoff_at);

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-muted">{league.name}</p>
        <h1 className="text-2xl font-bold">{match.title}</h1>
        <p className="text-sm text-muted">{formatMatchDate(kickoff, match.timezone)}</p>
        <div className="mt-1 flex flex-wrap items-center gap-4">
          <Link
            href={`/leagues/${league.slug}/matches`}
            className="text-sm underline underline-offset-4"
          >
            All matches
          </Link>
          {canEdit ? (
            <Link
              href={`/leagues/${league.slug}/matches/${match.id}/edit`}
              className="inline-flex min-h-9 items-center rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-sm font-semibold"
            >
              Edit match
            </Link>
          ) : null}
        </div>
      </header>

      {notice === null ? null : (
        <p
          role="status"
          className="rounded-lg border border-pitch-500/40 bg-pitch-50 px-3 py-2 text-sm text-pitch-900 dark:bg-pitch-900/40 dark:text-pitch-50"
        >
          {NOTICE_MESSAGES[notice]}
        </p>
      )}

      {match.status === 'canceled' ? (
        <p
          role="status"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200"
        >
          This match was canceled
          {match.cancellation_reason === null ? '.' : `: ${match.cancellation_reason}`}
        </p>
      ) : match.status === 'draft' ? (
        <p
          role="status"
          className="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm"
        >
          Draft — members cannot see this match yet.
        </p>
      ) : null}

      <section className="surface-card flex flex-col gap-3 p-4">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Arrive</dt>
            <dd className="font-semibold">
              {formatMatchTime(new Date(match.arrival_at), match.timezone)}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Kickoff</dt>
            <dd className="font-semibold">{formatMatchTime(kickoff, match.timezone)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Ends</dt>
            <dd className="font-semibold">
              {formatMatchTime(new Date(match.end_at), match.timezone)}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Timezone</dt>
            <dd className="font-semibold">{match.timezone}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Location</dt>
            <dd className="font-semibold">{match.location_name}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Teams</dt>
            <dd className="font-semibold">{match.team_count}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Capacity</dt>
            <dd className="font-semibold">{match.capacity} players</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Minimum</dt>
            <dd className="font-semibold">{match.min_players} players</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Spots filled by</dt>
            <dd className="font-semibold">
              {match.selection_mode === 'first_come' ? 'First come' : 'Administrator approval'}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Waitlist</dt>
            <dd className="font-semibold">
              {match.waitlist_mode === 'automatic' ? 'Automatic' : 'Administrator controlled'}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Signup closes</dt>
            <dd className="font-semibold">
              {formatMatchTime(new Date(match.signup_closes_at), match.timezone)}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted">Cancellation cutoff</dt>
            <dd className="font-semibold">
              {formatMatchTime(new Date(match.cancellation_cutoff_at), match.timezone)}
            </dd>
          </div>
        </dl>

        {match.location_map_url === null ? null : (
          <a
            href={match.location_map_url}
            rel="noopener noreferrer"
            target="_blank"
            className="text-sm underline underline-offset-4"
          >
            Open the map
          </a>
        )}

        {match.public_notes === null ? null : (
          <p className="whitespace-pre-wrap text-sm">{match.public_notes}</p>
        )}
      </section>

      <section className="surface-card p-4">
        <h2 className="text-base font-semibold">Signup</h2>
        <p className="mt-1 text-sm text-muted">{participationStateLabel(state)}.</p>
        <p className="mt-1 text-sm text-muted">
          Joining a match, waitlists and rosters arrive in the next phase. Nothing is being
          recorded for this match yet.
        </p>
      </section>

      {isAdmin ? (
        <section className="surface-card flex flex-col gap-4 p-4">
          <h2 className="text-base font-semibold">Administrator</h2>

          {adminNotes === null ? null : (
            <div>
              <p className="text-xs uppercase tracking-wide text-muted">Private notes</p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{adminNotes.notes}</p>
              <p className="mt-1 text-xs text-muted">Members cannot see these.</p>
            </div>
          )}

          {match.status === 'draft' ? (
            <PublishMatchButton leagueId={league.id} matchId={match.id} />
          ) : null}

          {match.status === 'canceled' ? null : (
            <CancelMatchForm leagueId={league.id} matchId={match.id} />
          )}

          <p className="text-xs text-muted">
            Revision {match.revision}
            {match.published_at === null
              ? ''
              : ` · published ${new Date(match.published_at).toLocaleDateString('en-GB')}`}
          </p>
        </section>
      ) : null}
    </>
  );
}

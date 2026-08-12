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
import { SignupControls, SignupStatusBadge } from '@/components/signup';
import { formatMatchDate, formatMatchTime } from '@/lib/matches/match-timing';
import { getMatch, getMatchAdminNotes } from '@/lib/matches/matches';
import { canEditMatch } from '@/lib/matches/match-permissions';
import {
  getConfirmedRoster,
  getMySignup,
  getSignupCounts,
  getSignupEligibility,
} from '@/lib/matches/signups';
import { getPublishedTeams, groupPublishedTeams } from '@/lib/matches/teams';
import {
  deriveMatchParticipationState,
  participationStateLabel,
  remainingSpots,
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

  // Phase 4 supplies the counts the Phase 3 helper was already built to accept.
  // `null` still means "no signup data", which is now only true for a match the
  // caller cannot see.
  const [counts, mySignup, roster, eligibility, teamEntries] = await Promise.all([
    getSignupCounts(matchId),
    getMySignup(matchId),
    getConfirmedRoster(matchId),
    getSignupEligibility(matchId),
    // Empty unless teams have been published *and* the caller is currently
    // confirmed. The projection enforces both, so this page never has to.
    getPublishedTeams(matchId),
  ]);

  const publishedTeams = groupPublishedTeams(teamEntries);
  const isConfirmed = mySignup?.status === 'confirmed';

  const state = deriveMatchParticipationState(
    counts === null
      ? null
      : { confirmed: counts.confirmed, capacity: counts.capacity, minPlayers: counts.min_players },
  );
  const openSpots = remainingSpots(
    counts === null
      ? null
      : { confirmed: counts.confirmed, capacity: counts.capacity, minPlayers: counts.min_players },
  );

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

      <section className="surface-card flex flex-col gap-3 p-4">
        <div>
          <h2 className="text-base font-semibold">Signup</h2>
          <p className="mt-1 text-sm text-muted">
            {participationStateLabel(state)}
            {counts === null ? '' : ` · ${counts.confirmed} of ${counts.capacity} confirmed`}
            {openSpots === null || openSpots === 0 ? '' : ` · ${openSpots} open`}
            {counts === null || counts.waitlisted === 0
              ? ''
              : ` · ${counts.waitlisted} waitlisted`}
          </p>
        </div>

        <SignupStatusBadge outcome={mySignup} />

        {match.status === 'canceled' ? null : (
          <SignupControls
            matchId={match.id}
            selectionMode={match.selection_mode}
            eligibility={eligibility}
            outcome={mySignup}
            // Rendered in the league's own zone, like every other time on this
            // page. Whether cancelling now is late comes from the database, so
            // the warning and the stored classification cannot disagree.
            cancellationCutoffLabel={formatMatchTime(
              new Date(match.cancellation_cutoff_at),
              match.timezone,
            )}
            cancellationIsLate={counts?.cancellation_is_late ?? false}
          />
        )}
      </section>

      <section className="surface-card p-4">
        <h2 className="text-base font-semibold">
          Confirmed roster <span className="text-muted">({roster.length})</span>
        </h2>
        {roster.length === 0 ? (
          <p className="mt-1 text-sm text-muted">Nobody is confirmed yet.</p>
        ) : (
          // Names only. The waitlist is deliberately absent: a member sees the
          // size of the queue in the line above, never who is in it or where.
          <ul className="mt-2 flex flex-col gap-1">
            {roster.map((player) => (
              <li key={player.membership_id} className="text-sm">
                {player.first_name} {player.last_name}
                {player.is_self ? <span className="ml-1.5 text-xs text-muted">(you)</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        Teams. Nothing appears until the administrator publishes, and then only
        for a confirmed player — a waitlisted, not-selected or cancelled member
        sees this section as absent rather than empty, because the projection
        returns them nothing at all.
      */}
      {isConfirmed && match.status !== 'canceled' ? (
        <section className="surface-card flex flex-col gap-3 p-4">
          <h2 className="text-base font-semibold">Teams</h2>

          {publishedTeams.length === 0 ? (
            <p className="text-sm text-muted">
              Teams have not been published yet. You will be told when they are.
            </p>
          ) : (
            <>
              {publishedTeams.some((team) =>
                team.players.some((player) => player.is_self),
              ) ? null : (
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  You have not been assigned to a team yet.
                </p>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                {publishedTeams.map((team) => {
                  const mine = team.players.some((player) => player.is_self);
                  return (
                    <div
                      key={team.displayOrder}
                      className={`rounded-lg border p-3 ${
                        mine
                          ? 'border-pitch-500/50 bg-pitch-50 dark:bg-pitch-900/40'
                          : 'border-[var(--border-subtle)]'
                      }`}
                    >
                      <p className="text-sm font-semibold">
                        {team.name}
                        {mine ? <span className="ml-1.5 text-xs">(your team)</span> : null}
                      </p>
                      {team.label === null ? null : (
                        <p className="text-xs text-muted">{team.label}</p>
                      )}
                      <ul className="mt-1.5 flex flex-col gap-0.5">
                        {team.players.map((player) => (
                          <li key={player.membership_id} className="text-sm">
                            {player.first_name} {player.last_name}
                            {player.is_self ? (
                              <span className="ml-1.5 text-xs text-muted">(you)</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>
      ) : null}

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

          {match.status === 'draft' ? null : (
            <div className="flex flex-wrap gap-2">
              <Link
                href={`/leagues/${league.slug}/matches/${match.id}/roster`}
                className="inline-flex min-h-11 w-fit items-center rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm font-semibold"
              >
                Manage roster
              </Link>
              <Link
                href={`/leagues/${league.slug}/matches/${match.id}/teams`}
                className="inline-flex min-h-11 w-fit items-center rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm font-semibold"
              >
                Manage teams
              </Link>
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
            {match.roster_finalized_at === null
              ? ' · roster not published'
              : ` · roster revision ${match.roster_revision}`}
            {match.teams_published_at === null
              ? ' · teams not published'
              : ` · team revision ${match.team_revision}`}
          </p>
        </section>
      ) : null}
    </>
  );
}

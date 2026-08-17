import type { Metadata } from 'next';
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
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Panel, Stat, StatGrid } from '@/components/ui/card';
import {
  AlertIcon,
  BallIcon,
  CheckIcon,
  ClipboardIcon,
  InfoIcon,
  PinIcon,
  SettingsIcon,
  ShieldIcon,
  UsersIcon,
} from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';
import { PlayerAvatar } from '@/components/ui/player-avatar';
import { Notice } from '@/components/ui/status';
import { formatMatchClock, formatMatchDate, formatMatchTime } from '@/lib/matches/match-timing';
import { getMatch, getMatchAdminNotes } from '@/lib/matches/matches';
import { canEditMatch } from '@/lib/matches/match-permissions';
import {
  getConfirmedRoster,
  getMySignup,
  getSignupCounts,
  getSignupEligibility,
} from '@/lib/matches/signups';
import { getMyAttendance } from '@/lib/matches/attendance';
import { ATTENDANCE_OUTCOME_LABELS } from '@/lib/matches/attendance-display';
import { getPublishedTeams, groupPublishedTeams } from '@/lib/matches/teams';
import {
  deriveMatchParticipationState,
  participationStateLabel,
  remainingSpots,
} from '@/lib/matches/threshold-state';
import { pluralize } from '@/lib/format/plural';

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
  [MATCH_NOTICES.published]: 'Match published — members have been notified.',
  // Says what did *not* happen, because that is the part somebody who meant to
  // publish needs to notice. The draft banner below repeats it in place.
  [MATCH_NOTICES.draftSaved]: 'Saved as a draft. Nobody has been notified yet.',
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
  const [counts, mySignup, roster, eligibility, teamEntries, myAttendance] = await Promise.all([
    getSignupCounts(matchId),
    getMySignup(matchId),
    getConfirmedRoster(matchId),
    getSignupEligibility(matchId),
    // Empty unless teams have been published *and* the caller is currently
    // confirmed. The projection enforces both, so this page never has to.
    getPublishedTeams(matchId),
    // The caller's own outcome, or null. There is no parameter for whose
    // attendance to read, and the note is absent from the projection, so
    // neither can reach this page for anybody.
    getMyAttendance(matchId),
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
      <PageHeader
        eyebrow={league.name}
        icon={<BallIcon size={13} />}
        title={match.title}
        description={formatMatchDate(kickoff, match.timezone)}
        back={{ href: `/leagues/${league.slug}/matches`, label: 'All matches' }}
        actions={
          canEdit ? (
            <ButtonLink
              href={`/leagues/${league.slug}/matches/${match.id}/edit`}
              icon={<SettingsIcon size={16} />}
            >
              Edit match
            </ButtonLink>
          ) : undefined
        }
      />

      {notice === null ? null : <Notice tone="success">{NOTICE_MESSAGES[notice]}</Notice>}

      {match.status === 'canceled' ? (
        <Notice tone="danger" icon={<AlertIcon size={17} />}>
          This match was canceled
          {match.cancellation_reason === null ? '.' : `: ${match.cancellation_reason}`}
        </Notice>
      ) : match.status === 'draft' ? (
        <Notice tone="info" icon={<InfoIcon size={17} />}>
          Draft — members cannot see this match yet.
        </Notice>
      ) : isAdmin && match.status === 'open' ? (
        // The counterpart to the draft banner, for the administrator only. A
        // draft says loudly that it is not live; until now nothing said the
        // opposite, so somebody arriving from the create form had to infer
        // "published" from the absence of a warning. Members do not need it:
        // for them an open match is simply a match.
        <Notice tone="success" icon={<CheckIcon size={17} />}>
          Open — members can see this match and sign up.
        </Notice>
      ) : null}

      {/*
        The three times that decide whether somebody turns up, pulled out of the
        twelve-cell definition list they used to be buried in. Arrive, kickoff
        and end were previously the same size and weight as "Waitlist mode".
      */}
      <Panel className="animate-rise">
        {/* Clock times only. The date is in the page header directly above and
            the zone is named once in the stats below, so repeating both in each
            of three narrow columns wrapped every cell onto three lines. */}
        <div className="grid grid-cols-3 divide-x divide-[var(--border-subtle)]">
          {[
            { label: 'Arrive', value: new Date(match.arrival_at) },
            { label: 'Kickoff', value: kickoff },
            { label: 'Ends', value: new Date(match.end_at) },
          ].map(({ label, value }) => (
            <div key={label} className="flex flex-col items-center gap-1.5 px-2 py-4">
              <span className="text-[0.625rem] font-bold uppercase tracking-[0.09em] text-muted">
                {label}
              </span>
              <span className="tabular text-xl font-bold leading-none">
                {formatMatchClock(value, match.timezone)}
              </span>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-4 border-t border-[var(--border-subtle)] bg-[var(--surface-raised)] p-4">
          <div className="flex items-start gap-2.5">
            <PinIcon size={17} className="mt-0.5 text-muted" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-sm font-semibold">{match.location_name}</p>
              {match.location_map_url === null ? null : (
                <a
                  href={match.location_map_url}
                  rel="noopener noreferrer"
                  target="_blank"
                  className="w-fit text-sm font-medium text-pitch-700 underline decoration-pitch-500/40 underline-offset-4 hover:decoration-pitch-500 dark:text-pitch-300"
                >
                  Open the map
                </a>
              )}
            </div>
          </div>

          <StatGrid>
            <Stat label="Capacity" value={pluralize(match.capacity, 'player')} />
            <Stat label="Minimum" value={pluralize(match.min_players, 'player')} />
            <Stat label="Teams" value={match.team_count} />
            <Stat label="Timezone" value={match.timezone} />
            <Stat
              label="Spots filled by"
              value={match.selection_mode === 'first_come' ? 'First come' : 'Administrator approval'}
            />
            <Stat
              label="Waitlist"
              value={match.waitlist_mode === 'automatic' ? 'Automatic' : 'Administrator controlled'}
            />
            <Stat
              label="Signup closes"
              value={formatMatchTime(new Date(match.signup_closes_at), match.timezone)}
            />
            <Stat
              label="Cancellation cutoff"
              value={formatMatchTime(new Date(match.cancellation_cutoff_at), match.timezone)}
            />
          </StatGrid>

          {match.public_notes === null ? null : (
            <p className="surface-sunken whitespace-pre-wrap p-3 text-sm leading-relaxed">
              {match.public_notes}
            </p>
          )}
        </div>
      </Panel>

      <section className="surface-card animate-rise flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-2">
          <h2 className="text-[0.9375rem] font-semibold">Signup</h2>

          {/*
            A capacity bar. The old line read "Filling up · 8 of 14 confirmed ·
            6 open · 2 waitlisted" in 14px grey, which is four facts in one
            sentence and none of them answerable at a glance. The bar answers
            the only one anybody scans for — is there room — and the numbers
            stay underneath for the rest.
          */}
          {counts === null ? null : (
            <div className="flex flex-col gap-1.5">
              <div
                className="surface-sunken h-2 w-full overflow-hidden rounded-full p-0"
                role="img"
                aria-label={`${counts.confirmed} of ${counts.capacity} places confirmed`}
              >
                <div
                  className="h-full rounded-full bg-pitch-500 transition-[width] duration-500"
                  style={{
                    width: `${String(
                      Math.min(100, Math.round((counts.confirmed / Math.max(counts.capacity, 1)) * 100)),
                    )}%`,
                  }}
                />
              </div>
              <p className="tabular text-sm text-secondary">
                <span className="font-semibold text-[var(--text-primary)]">
                  {counts.confirmed} of {counts.capacity}
                </span>{' '}
                confirmed
                {openSpots === null || openSpots === 0 ? '' : ` · ${openSpots} open`}
                {counts.waitlisted === 0 ? '' : ` · ${counts.waitlisted} waitlisted`}
              </p>
            </div>
          )}

          <p className="text-sm text-muted">{participationStateLabel(state)}</p>
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

      {/*
        The caller's own attendance, once an administrator has recorded it.
        Their outcome and nothing else: no note, no comparison with anybody
        else, and no count of how often this has happened. 7F asks that a player
        can see what was recorded about them, which is a matter of it being
        visible rather than of it being emphasised.
      */}
      {myAttendance === null ? null : (
        <section className="surface-card flex flex-col gap-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[0.9375rem] font-semibold">Your attendance</h2>
            <Badge tone={myAttendance.outcome === 'attended' ? 'live' : 'neutral'} dot>
              {ATTENDANCE_OUTCOME_LABELS[myAttendance.outcome]}
            </Badge>
          </div>
          <p className="text-xs leading-relaxed text-muted">
            Recorded by your league administrator on{' '}
            {new Date(myAttendance.recorded_at).toLocaleDateString('en-GB', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
            })}
            . If this looks wrong, speak to them and they can correct it.
          </p>
        </section>
      )}

      <section className="surface-card p-4">
        <h2 className="flex items-center gap-2 text-[0.9375rem] font-semibold">
          Confirmed roster
          <Badge tone="neutral">{roster.length}</Badge>
        </h2>
        {roster.length === 0 ? (
          <p className="mt-2 text-sm text-muted">
            Nobody is confirmed yet. The first player to sign up appears here.
          </p>
        ) : (
          // Names only. The waitlist is deliberately absent: a member sees the
          // size of the queue in the line above, never who is in it or where.
          <ul className="mt-2 flex flex-col gap-1.5">
            {roster.map((player) => (
              <li key={player.membership_id} className="flex items-center gap-2 text-sm">
                {/* 24px: the row was a single line of `text-sm`, so this adds
                    four pixels of height rather than turning a twenty-player
                    roster into a scroll. `min-w-0` + `truncate` on the name is
                    what keeps a long one from pushing the row past 320px. */}
                <PlayerAvatar player={player} size={24} />
                <span className="min-w-0 truncate">
                  {player.first_name} {player.last_name}
                  {player.is_self ? <span className="ml-1.5 text-xs text-muted">(you)</span> : null}
                </span>
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
          <h2 className="text-[0.9375rem] font-semibold">Teams</h2>

          {publishedTeams.length === 0 ? (
            <p className="text-sm text-muted">
              Teams have not been published yet. You will be told when they are.
            </p>
          ) : (
            <>
              {publishedTeams.some((team) =>
                team.players.some((player) => player.is_self),
              ) ? null : (
                <p className="text-sm text-flag-700 dark:text-flag-200">
                  You have not been assigned to a team yet.
                </p>
              )}

              {/*
                A list of groups, not a grid of anonymous divs.

                Each team is a `group` with its own accessible name, so a screen
                reader announces "Team 1 (your team), group" on entry and can
                jump between teams — where before it read one undifferentiated
                run of names and the reader had no way to tell where one team
                ended and the next began. The heading carries the same name
                visually.

                It is also the only stable handle a test has on "the player's
                own team". Locating by text alone matches the card *and* every
                ancestor that contains it, and which of those a `.first()`
                resolves to depends on how much of the page has streamed in.
              */}
              <ul className="grid list-none gap-3 sm:grid-cols-2">
                {publishedTeams.map((team) => {
                  const mine = team.players.some((player) => player.is_self);
                  const accessibleName = mine ? `${team.name} (your team)` : team.name;
                  return (
                    <li
                      key={team.displayOrder}
                      role="group"
                      aria-label={accessibleName}
                      // `min-w-0`: a grid item will not shrink below its
                      // content's min-content width, and a truncating name is
                      // `white-space: nowrap`, so its min-content width is the
                      // whole name. Without this the team card grows to fit the
                      // longest name on the sheet and the page scrolls
                      // sideways at 320px.
                      className={`min-w-0 rounded-lg border p-3 ${
                        mine
                          ? 'border-pitch-500/50 bg-pitch-50 dark:bg-pitch-900/40'
                          : 'border-[var(--border-subtle)]'
                      }`}
                    >
                      <h3 className="text-sm font-semibold">
                        {team.name}
                        {mine ? <span className="ml-1.5 text-xs">(your team)</span> : null}
                      </h3>
                      {team.label === null ? null : (
                        <p className="text-xs text-muted">{team.label}</p>
                      )}
                      <ul className="mt-1.5 flex flex-col gap-1">
                        {team.players.map((player) => (
                          <li
                            key={player.membership_id}
                            className="flex items-center gap-2 text-sm"
                          >
                            <PlayerAvatar player={player} size={24} />
                            <span className="min-w-0 truncate">
                              {player.first_name} {player.last_name}
                              {player.is_self ? (
                                <span className="ml-1.5 text-xs text-muted">(you)</span>
                              ) : null}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      ) : null}

      {isAdmin ? (
        <section className="surface-card flex flex-col gap-4 p-4">
          <h2 className="flex items-center gap-2 text-[0.9375rem] font-semibold">
            <ShieldIcon size={16} className="text-pitch-600 dark:text-pitch-300" />
            Administrator
          </h2>

          {adminNotes === null ? null : (
            <div className="surface-sunken flex flex-col gap-1 p-3">
              <p className="text-[0.6875rem] font-bold uppercase tracking-[0.07em] text-muted">
                Private notes
              </p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{adminNotes.notes}</p>
              <p className="text-xs text-muted">Members cannot see these.</p>
            </div>
          )}

          {match.status === 'draft' ? null : (
            <div className="flex flex-wrap gap-2">
              <ButtonLink
                href={`/leagues/${league.slug}/matches/${match.id}/roster`}
                icon={<UsersIcon size={16} />}
              >
                Manage roster
              </ButtonLink>
              <ButtonLink
                href={`/leagues/${league.slug}/matches/${match.id}/teams`}
                icon={<ShieldIcon size={16} />}
              >
                Manage teams
              </ButtonLink>
              {/* Offered from the moment a match is published rather than only
                  after it ends: the register is where an administrator goes
                  after the final whistle, and a link that appears out of
                  nowhere is harder to find than one that has always been
                  there. The page itself explains that it is not open yet. */}
              <ButtonLink
                href={`/leagues/${league.slug}/matches/${match.id}/attendance`}
                icon={<ClipboardIcon size={16} />}
              >
                Attendance
              </ButtonLink>
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

import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card, CardList, Section } from '@/components/ui/card';
import {
  BallIcon,
  CalendarIcon,
  ChevronRightIcon,
  ClipboardIcon,
  PinIcon,
  PlusIcon,
} from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';
import { PillNav } from '@/components/ui/pill-nav';
import { EmptyState } from '@/components/ui/status';
import { requireLeagueMemberPage } from '@/lib/auth/page-guards';
import { getMyAttendanceHistory } from '@/lib/matches/attendance';
import { ATTENDANCE_OUTCOME_LABELS } from '@/lib/matches/attendance-display';
import { formatMatchTime } from '@/lib/matches/match-timing';
import { getPastMatches, getUpcomingMatches } from '@/lib/matches/matches';
import type { MatchRow } from '@/types/database';
import { pluralize } from '@/lib/format/plural';

export const metadata: Metadata = { title: 'Matches' };

/**
 * One fixture.
 *
 * ── WHAT CHANGED ───────────────────────────────────────────────────────────
 *
 * The title was a small underlined link and the whole card was inert around it,
 * so the tap target for "open this match" was about 140×20px in the corner of a
 * 300px card. The card is now the target — the link stretches over it with an
 * inset overlay — and the title is a heading rather than a link, which is also
 * what makes the list navigable by heading in a screen reader.
 *
 * The date is the loudest thing on the card, because scanning a fixture list is
 * almost always looking for *when*.
 */
function MatchCard({ match, slug }: { match: MatchRow; slug: string }) {
  const canceled = match.status === 'canceled';
  const draft = match.status === 'draft';

  const kickoff = new Date(match.kickoff_at);
  const day = kickoff.toLocaleDateString('en-GB', {
    weekday: 'short',
    timeZone: match.timezone,
  });
  const date = kickoff.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: match.timezone,
  });

  return (
    <Card
      as="li"
      interactive
      className={`animate-rise relative p-4 ${canceled ? 'opacity-70' : ''}`}
    >
      <div className="flex items-start gap-3.5">
        {/* A date block, the way a calendar app does it. Three lines of prose
            saying "Monday 14 April, 19:00" is how the old card opened, and it
            is the slowest possible way to answer "which one is Thursday". */}
        <div
          aria-hidden="true"
          className={`flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-[var(--radius-md)] border ${
            canceled
              ? 'border-whistle-200 bg-whistle-50 text-whistle-700 dark:border-whistle-900 dark:bg-whistle-900/30 dark:text-whistle-200'
              : 'border-pitch-200 bg-pitch-50 text-pitch-800 dark:border-pitch-800 dark:bg-pitch-900/40 dark:text-pitch-100'
          }`}
        >
          <span className="text-[0.625rem] font-bold uppercase tracking-wide opacity-80">{day}</span>
          <span className="tabular text-sm font-bold leading-tight">{date}</span>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 text-[0.9375rem] font-semibold leading-snug">
              {/* Stretched link: the accessible name and the semantics stay on
                  one element, and the whole card becomes the target. */}
              <Link
                href={`/leagues/${slug}/matches/${match.id}`}
                className="after:absolute after:inset-0 after:content-['']"
              >
                {match.title}
              </Link>
            </h3>
            <Badge tone={canceled ? 'off' : draft ? 'info' : 'live'} dot={!draft}>
              {canceled ? 'Canceled' : draft ? 'Draft' : 'Open'}
            </Badge>
          </div>

          <p className="flex items-center gap-1.5 text-sm text-secondary">
            <CalendarIcon size={14} className="text-muted" />
            <span className="min-w-0 truncate">
              {formatMatchTime(kickoff, match.timezone)}
            </span>
          </p>
          <p className="flex items-center gap-1.5 text-sm text-muted">
            <PinIcon size={14} />
            <span className="min-w-0 truncate">{match.location_name}</span>
          </p>

          {/*
            NO PARTICIPATION LABEL HERE.

            This card used to render `participationStateLabel(null)`, and with
            no counts fetched for a list that could only ever resolve to one
            string: "Signup opens in a later phase". Phase 4 shipped signup two
            years of phases ago, so every fixture in the product was carrying a
            sentence that had stopped being true — and the redesign made it
            worse by putting it on a card somebody actually reads.

            Deliberately removed rather than fixed by fetching counts per match:
            that is a data change, and the honest minimum is to stop saying
            something untrue. The real number is one tap away on the match
            itself, where the counts are already loaded.
          */}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span className="tabular">
              {pluralize(match.capacity, 'place')} · {pluralize(match.min_players, 'player')} min
            </span>
          </div>
        </div>
      </div>
    </Card>
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
      <PageHeader
        eyebrow={league.name}
        icon={<BallIcon size={13} />}
        title="Matches"
        description="Every match in this league, newest first."
        actions={
          isAdmin ? (
            <ButtonLink
              href={`/leagues/${league.slug}/matches/new`}
              variant="primary"
              icon={<PlusIcon size={17} />}
            >
              Create a match
            </ButtonLink>
          ) : undefined
        }
      />

      <PillNav
        label="League"
        items={[
          { href: `/leagues/${league.slug}/guidelines`, label: 'Guidelines' },
          ...(isAdmin
            ? [
                { href: `/leagues/${league.slug}/templates`, label: 'Templates' },
                { href: `/leagues/${league.slug}/members`, label: 'Members' },
                { href: `/leagues/${league.slug}/settings`, label: 'Settings' },
              ]
            : []),
        ]}
      />

      <Section title="Upcoming">
        {upcoming.length === 0 ? (
          <EmptyState
            icon={<CalendarIcon size={22} />}
            title="No matches scheduled"
            description={
              isAdmin
                ? 'Create the first match and your players will be able to sign up for it straight away.'
                : 'Nothing is on the calendar yet. Your league administrator will publish matches here, and you will get a notification when they do.'
            }
            action={
              isAdmin ? (
                <ButtonLink
                  href={`/leagues/${league.slug}/matches/new`}
                  variant="primary"
                  icon={<PlusIcon size={17} />}
                >
                  Create a match
                </ButtonLink>
              ) : undefined
            }
          />
        ) : (
          <ul className="stagger flex flex-col gap-3">
            {upcoming.map((match) => (
              <MatchCard key={match.id} match={match} slug={league.slug} />
            ))}
          </ul>
        )}
      </Section>

      {past.length > 0 ? (
        <Section title="Recent">
          <ul className="flex flex-col gap-3">
            {past.map((match) => (
              <MatchCard key={match.id} match={match} slug={league.slug} />
            ))}
          </ul>
        </Section>
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
        <Section
          title="Your attendance"
          description="Recorded by your league administrator. If something looks wrong, speak to them and they can correct it."
        >
          <Card className="overflow-hidden p-0">
            <CardList>
              {attendance.map((entry) => (
                <li key={entry.match_id} className="relative">
                  <Link
                    href={`/leagues/${league.slug}/matches/${entry.match_id}`}
                    className="press flex items-center gap-3 px-4 py-3 hover:bg-[var(--surface-hover)]"
                  >
                    <ClipboardIcon size={16} className="text-muted" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium">{entry.match_title}</span>
                      <span className="tabular text-xs text-muted">
                        {new Date(entry.kickoff_at).toLocaleDateString('en-GB', {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </span>
                    </span>
                    <Badge tone={entry.outcome === 'attended' ? 'live' : 'neutral'}>
                      {ATTENDANCE_OUTCOME_LABELS[entry.outcome]}
                    </Badge>
                    <ChevronRightIcon size={15} className="text-muted" />
                  </Link>
                </li>
              ))}
            </CardList>
          </Card>
        </Section>
      )}
    </>
  );
}

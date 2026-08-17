import type { Metadata } from 'next';
import { PublicLeagueCard, WithdrawRequestButton } from '@/components/discovery';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card, Section } from '@/components/ui/card';
import { inputClassName } from '@/components/ui/field';
import { PlusIcon, SearchIcon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/status';
import { getMyMemberships } from '@/lib/auth/authorization';
import { requireOnboardedUser } from '@/lib/auth/page-guards';
import { searchPublicLeagues } from '@/lib/leagues/discovery';
import { getMyPendingJoinRequests } from '@/lib/leagues/league-admin';

export const metadata: Metadata = { title: 'Find a league' };

/**
 * League discovery.
 *
 * Results come from `public.searchable_leagues_public` and nothing else, so a
 * private league cannot appear here regardless of what is typed into the search
 * box. The caller's own memberships and pending requests are read separately,
 * under their own Row Level Security, purely to decide which button to show.
 */
export default async function DiscoverLeaguesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOnboardedUser();

  const params = await searchParams;
  const rawQuery = typeof params['q'] === 'string' ? params['q'] : '';

  const [leagues, memberships, pendingRequests] = await Promise.all([
    searchPublicLeagues(rawQuery),
    getMyMemberships(),
    getMyPendingJoinRequests(),
  ]);

  const memberLeagueIds = new Set(memberships.map((entry) => entry.league.id));
  const requestedLeagueIds = new Set(pendingRequests.map((entry) => entry.request.league_id));

  return (
    <>
      <PageHeader
        title="Find a league"
        description="Only leagues that have chosen to be searchable appear here."
        actions={
          <ButtonLink href="/leagues/new" icon={<PlusIcon size={17} />}>
            Create a league
          </ButtonLink>
        }
      />

      {/* The magnifier sits inside the field rather than on a separate button
          label, which is what makes a search box read as one at a glance. The
          submit stays a real button so the form works without JavaScript. */}
      <form method="get" className="animate-rise flex gap-2">
        <label htmlFor="q" className="sr-only">
          Search by name or area
        </label>
        <div className="relative flex-1">
          <SearchIcon
            size={18}
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            id="q"
            name="q"
            defaultValue={rawQuery}
            placeholder="Search by name or area"
            className={`${inputClassName} pl-11`}
          />
        </div>
        <button
          type="submit"
          className="press inline-flex min-h-control shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-pitch-600 px-4 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-card)] hover:bg-pitch-700 dark:bg-pitch-500 dark:text-pitch-950 dark:hover:bg-pitch-400"
        >
          Search
        </button>
      </form>

      {pendingRequests.length > 0 ? (
        <Section title="Awaiting approval" description="You have asked to join these.">
          <Card className="overflow-hidden p-0">
            <ul className="divide-hairline flex flex-col">
              {pendingRequests.map(({ request, leagueName }) => (
                <li key={request.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <Badge tone="pending" dot>
                      Pending
                    </Badge>
                    <span className="min-w-0 truncate text-sm font-medium">
                      {leagueName ?? 'A league'}
                    </span>
                  </span>
                  <WithdrawRequestButton requestId={request.id} />
                </li>
              ))}
            </ul>
          </Card>
        </Section>
      ) : null}

      {leagues.length === 0 ? (
        <EmptyState
          icon={<SearchIcon size={22} />}
          title={rawQuery === '' ? 'No leagues to show yet' : 'Nothing matched that search'}
          description={
            rawQuery === ''
              ? 'No league has made itself searchable yet. If you were sent an invitation link, open that instead — private leagues never appear here.'
              : `No searchable leagues match “${rawQuery}”. Try a shorter word, or the area rather than the name.`
          }
          action={
            <ButtonLink href="/leagues/new" variant="primary" icon={<PlusIcon size={17} />}>
              Create a league
            </ButtonLink>
          }
        />
      ) : (
        <ul className="stagger flex flex-col gap-3">
          {leagues.map((league) => (
            <PublicLeagueCard
              key={league.id}
              league={league}
              relationship={
                memberLeagueIds.has(league.id)
                  ? 'member'
                  : requestedLeagueIds.has(league.id)
                    ? 'requested'
                    : 'none'
              }
            />
          ))}
        </ul>
      )}
    </>
  );
}

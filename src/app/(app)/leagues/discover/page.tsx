import type { Metadata } from 'next';
import { PublicLeagueCard, WithdrawRequestButton } from '@/components/discovery';
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
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Find a league</h1>
        <p className="text-sm text-muted">
          Only leagues that have chosen to be searchable appear here.
        </p>
      </header>

      <form method="get" className="flex gap-2">
        <label htmlFor="q" className="sr-only">
          Search by name or area
        </label>
        <input
          id="q"
          name="q"
          defaultValue={rawQuery}
          placeholder="Search by name or area"
          className="min-h-11 flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 text-base"
        />
        <button
          type="submit"
          className="min-h-11 rounded-lg border border-[var(--border-subtle)] px-4 py-2 text-sm font-semibold"
        >
          Search
        </button>
      </form>

      {pendingRequests.length > 0 ? (
        <section className="surface-card flex flex-col gap-2 p-4">
          <h2 className="text-base font-semibold">Awaiting approval</h2>
          <ul className="flex flex-col gap-2">
            {pendingRequests.map(({ request, leagueName }) => (
              <li key={request.id} className="flex items-center justify-between gap-3 text-sm">
                <span>{leagueName ?? 'A league'}</span>
                <WithdrawRequestButton requestId={request.id} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {leagues.length === 0 ? (
        <p className="text-sm text-muted">
          {rawQuery === ''
            ? 'No leagues are searchable yet.'
            : `No searchable leagues match “${rawQuery}”.`}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
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

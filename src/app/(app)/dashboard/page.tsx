import type { Metadata } from 'next';
import Link from 'next/link';
import { requireOnboardedUser } from '@/lib/auth/page-guards';
import { getLeagueContext } from '@/lib/leagues/active-league';

export const metadata: Metadata = { title: 'Home' };

export default async function DashboardPage() {
  const { profile } = await requireOnboardedUser();
  const { active, switcher } = await getLeagueContext();
  const totalMemberships =
    switcher.active.length + switcher.pending.length + switcher.suspended.length;

  return (
    <>
      <section className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">Hello, {profile.first_name}</h1>
        <p className="text-sm text-muted">
          {totalMemberships === 0
            ? 'You are not a member of any league yet.'
            : `You hold ${totalMemberships} league ${totalMemberships === 1 ? 'membership' : 'memberships'}.`}
        </p>
      </section>

      {active === null ? (
        <section className="surface-card p-4">
          <h2 className="text-base font-semibold">No active league</h2>
          <p className="mt-1 text-sm text-muted">
            {switcher.pending.length > 0
              ? 'Your membership is still awaiting approval from the league administrator.'
              : 'Joining a league happens through an invitation or a join request, which arrive in the next phase.'}
          </p>
        </section>
      ) : (
        <section className="surface-card flex flex-col gap-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">{active.league.name}</h2>
              <p className="text-sm text-muted">
                {active.league.sport_label} · {active.league.general_area}
              </p>
            </div>
            <span className="rounded-full border border-[var(--border-subtle)] px-2.5 py-1 text-xs font-medium">
              {active.membership.role === 'league_admin' ? 'Administrator' : 'Player'}
            </span>
          </div>

          <p className="text-sm">{active.league.description}</p>

          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Default capacity</dt>
              <dd className="font-semibold">{active.league.default_capacity} players</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Minimum to play</dt>
              <dd className="font-semibold">{active.league.default_min_players} players</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Visibility</dt>
              <dd className="font-semibold capitalize">{active.league.visibility}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Timezone</dt>
              <dd className="font-semibold">{active.league.timezone}</dd>
            </div>
          </dl>

          {active.league.typical_schedule === null ? null : (
            <p className="text-sm text-muted">Usually plays: {active.league.typical_schedule}</p>
          )}
        </section>
      )}

      <section className="surface-card p-4">
        <h2 className="text-base font-semibold">What is here so far</h2>
        <p className="mt-1 text-sm text-muted">
          This is the Phase 1 foundation: one account, many leagues, tenant-isolated data, and the
          league switcher. Matches, signup, rosters, waitlists, teams and notifications are built in
          later phases.
        </p>
        <Link
          href="/profile"
          className="mt-3 inline-block text-sm font-semibold underline underline-offset-4"
        >
          Edit your profile
        </Link>
      </section>
    </>
  );
}

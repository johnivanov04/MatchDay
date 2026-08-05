import type { Metadata } from 'next';
import Link from 'next/link';
import {
  DASHBOARD_NOTICES,
  parseDashboardNotice,
  requireOnboardedUser,
  type DashboardNotice,
} from '@/lib/auth/page-guards';
import { getLeagueContext } from '@/lib/leagues/active-league';

export const metadata: Metadata = { title: 'Home' };

/**
 * Explains why someone arrived here from somewhere else.
 *
 * Purely informational. The redirect that produced it already enforced the
 * rule; this only stops a clean redirect from reading as a broken link.
 */
const NOTICE_MESSAGES: Record<DashboardNotice, string> = {
  [DASHBOARD_NOTICES.administrationTransferred]:
    'Administration transferred. You are now an ordinary player in that league.',
  [DASHBOARD_NOTICES.notLeagueAdmin]:
    'That page is only available to the league administrator.',
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { profile } = await requireOnboardedUser();
  const { active, switcher } = await getLeagueContext();
  const notice = parseDashboardNotice((await searchParams)['notice']);
  const totalMemberships =
    switcher.active.length + switcher.pending.length + switcher.suspended.length;

  return (
    <>
      {notice === null ? null : (
        <p
          role="status"
          className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 text-sm"
        >
          {NOTICE_MESSAGES[notice]}
        </p>
      )}

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
              : 'Find a searchable league to join, open an invitation link, or create your own.'}
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

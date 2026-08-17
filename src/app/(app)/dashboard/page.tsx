import type { Metadata } from 'next';
import { MembershipNotices } from '@/components/membership-notices';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card, Panel, Section, Stat, StatGrid } from '@/components/ui/card';
import {
  BallIcon,
  ChevronRightIcon,
  ClipboardIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
} from '@/components/ui/icon';
import { EmptyState, Notice } from '@/components/ui/status';
import {
  DASHBOARD_NOTICES,
  parseDashboardNotice,
  requireOnboardedUser,
  type DashboardNotice,
} from '@/lib/auth/page-guards';
import { getLeagueContext } from '@/lib/leagues/active-league';
import { pluralize } from '@/lib/format/plural';

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
  [DASHBOARD_NOTICES.notLeagueMember]:
    'That page is only available to active members of that league.',
};

/**
 * A destination in the league's own toolkit.
 *
 * A row rather than a button: these are navigation, there are up to four of
 * them, and four buttons in a grid would each claim the visual weight of a
 * primary action. The chevron is what marks them as "goes somewhere".
 */
function QuickLink({
  href,
  icon,
  title,
  description,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <li>
      <ButtonLink
        href={href}
        variant="ghost"
        className="w-full justify-start gap-3 rounded-none px-4 py-3.5 text-left"
      >
        <span
          aria-hidden="true"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-pitch-50 text-pitch-700 dark:bg-pitch-900/50 dark:text-pitch-300"
        >
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold text-[var(--text-primary)]">{title}</span>
          <span className="truncate text-xs font-normal text-muted">{description}</span>
        </span>
        <ChevronRightIcon size={16} className="text-muted" />
      </ButtonLink>
    </li>
  );
}

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

  const isAdmin = active?.membership.role === 'league_admin';

  return (
    <>
      {notice === null ? null : <Notice tone="info">{NOTICE_MESSAGES[notice]}</Notice>}

      {/*
        NO AVATAR HERE, DELIBERATELY.

        The obvious place for one is beside this greeting — and it would sit
        roughly a hundred pixels below the app bar, which already shows the same
        person's face. Two copies of one avatar, stacked, on the first screen
        somebody sees after signing in.

        The app bar's is the useful one: it is on every page, it doubles as the
        link to the profile, and it is where somebody checks "am I signed in as
        me". Repeating it here would add clutter and no information.
      */}
      <header className="animate-rise flex flex-col gap-1">
        <h1 className="text-[1.75rem] font-bold leading-tight">Hello, {profile.first_name}</h1>
        <p className="text-sm text-secondary">
          {totalMemberships === 0
            ? 'You are not a member of any league yet.'
            : `You hold ${totalMemberships} league ${totalMemberships === 1 ? 'membership' : 'memberships'}.`}
        </p>
      </header>

      {active === null ? (
        <EmptyState
          icon={<BallIcon size={22} />}
          title="No active league"
          description={
            switcher.pending.length > 0
              ? 'Your membership is still awaiting approval from the league administrator. You will get a notification the moment they decide.'
              : 'Join a league to see matches, rosters and team sheets. Search for one that is open to new players, open an invitation link, or start your own.'
          }
          action={
            <div className="flex flex-wrap gap-2">
              <ButtonLink href="/leagues/discover" variant="primary" icon={<SearchIcon size={17} />}>
                Find a league
              </ButtonLink>
              <ButtonLink href="/leagues/new" icon={<PlusIcon size={17} />}>
                Create a league
              </ButtonLink>
            </div>
          }
        />
      ) : (
        <Panel className="animate-rise">
          <div className="flex flex-col gap-4 p-5">
            <div className="flex items-start justify-between gap-3">
              {/* No "Active league" eyebrow here. The sticky strip forty pixels
                  above already says it, and the screenshot review showed the
                  phrase twice on one screen with the same league name under
                  each. The panel is the detail; the strip is the label. */}
              <div className="flex min-w-0 flex-col gap-1">
                <h2 className="text-xl font-bold leading-tight">{active.league.name}</h2>
                <p className="text-sm text-muted">
                  {active.league.sport_label} · {active.league.general_area}
                </p>
              </div>
              <Badge tone={isAdmin ? 'live' : 'neutral'} dot>
                {isAdmin ? 'Administrator' : 'Player'}
              </Badge>
            </div>

            {active.league.description === '' ? null : (
              <p className="text-sm leading-relaxed text-secondary">{active.league.description}</p>
            )}

            <StatGrid>
              <Stat label="Capacity" value={pluralize(active.league.default_capacity, 'player')} />
              <Stat label="Minimum" value={pluralize(active.league.default_min_players, 'player')} />
              <Stat label="Visibility" value={<span className="capitalize">{active.league.visibility}</span>} />
              <Stat label="Timezone" value={active.league.timezone} />
            </StatGrid>

            {active.league.typical_schedule === null ? null : (
              <p className="text-sm text-muted">
                Usually plays: {active.league.typical_schedule}
              </p>
            )}
          </div>

          {/* The league's own toolkit, as rows inside the panel rather than as
              links scattered through a global header. Guidelines is for
              everybody; the rest appear only for the administrator, and the
              server re-checks all of them anyway. */}
          {/* No "Matches" row here, deliberately: it is the second bottom tab,
              and a second link with the same name on the same screen is a
              duplicate for anybody navigating by accessible name — including
              the end-to-end suite, which would find two and refuse both. */}
          <ul className="divide-hairline flex flex-col border-t border-[var(--border-subtle)] bg-[var(--surface-raised)]">
            <QuickLink
              href={`/leagues/${active.league.slug}/guidelines`}
              icon={<ClipboardIcon size={18} />}
              title="Guidelines"
              description="What this league asks of its players"
            />
            {isAdmin ? (
              <>
                <QuickLink
                  href={`/leagues/${active.league.slug}/members`}
                  icon={<UsersIcon size={18} />}
                  title="Members"
                  description="Invitations, requests and membership"
                />
                <QuickLink
                  href={`/leagues/${active.league.slug}/settings`}
                  icon={<SettingsIcon size={18} />}
                  title="League settings"
                  description="Defaults, visibility and administration"
                />
              </>
            ) : null}
          </ul>
        </Panel>
      )}

      {/* Switching moved to the league menu behind the active-league strip,
          which is on every screen rather than on this one. What is left is the
          pending and suspended memberships PRD §11 asks to be visible — and
          only when there is no active league, because otherwise the strip is
          directly above this and its menu already lists them. */}
      {active === null ? <MembershipNotices model={switcher} /> : null}

      {active === null ? null : (
        <Section title="Other leagues" description="Join another, or start one of your own.">
          <div className="grid gap-3 sm:grid-cols-2">
            <Card interactive className="p-0">
              <ButtonLink
                href="/leagues/discover"
                variant="ghost"
                className="w-full items-start justify-start gap-3 p-4 text-left"
              >
                <span
                  aria-hidden="true"
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-pitch-50 text-pitch-700 dark:bg-pitch-900/50 dark:text-pitch-300"
                >
                  <SearchIcon size={18} />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-semibold text-[var(--text-primary)]">
                    Find a league
                  </span>
                  <span className="text-xs font-normal text-muted">
                    Browse leagues open to new players
                  </span>
                </span>
              </ButtonLink>
            </Card>
            <Card interactive className="p-0">
              <ButtonLink
                href="/leagues/new"
                variant="ghost"
                className="w-full items-start justify-start gap-3 p-4 text-left"
              >
                <span
                  aria-hidden="true"
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-pitch-50 text-pitch-700 dark:bg-pitch-900/50 dark:text-pitch-300"
                >
                  <PlusIcon size={18} />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-semibold text-[var(--text-primary)]">
                    Create a league
                  </span>
                  <span className="text-xs font-normal text-muted">
                    You become its administrator
                  </span>
                </span>
              </ButtonLink>
            </Card>
          </div>
        </Section>
      )}
    </>
  );
}

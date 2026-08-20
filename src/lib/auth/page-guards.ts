import 'server-only';

import { redirect } from 'next/navigation';
import {
  getCurrentProfile,
  getSessionUser,
  isProfileDeleting,
  type SessionUser,
} from '@/lib/auth/session';
import { findMyLeagueBySlug } from '@/lib/leagues/league-admin';
import type { LeagueMembershipRow, LeagueRow, ProfileRow } from '@/types/database';

/**
 * Route guards for pages and layouts.
 *
 * WHY THESE EXIST, RATHER THAN `requireCurrentProfile()`:
 *
 * In the App Router a layout and the page beneath it render *concurrently*.
 * `(app)/layout.tsx` redirecting an un-onboarded user therefore does not stop
 * `(app)/dashboard/page.tsx` from rendering — both run. When the page asserted
 * the profile with a helper that threw `DomainError('PROFILE_INCOMPLETE')`,
 * Next.js saw an ordinary application error escape a render and logged a full
 * stack, even though the user was already being redirected correctly.
 *
 * `redirect()` throws `NEXT_REDIRECT`, a control-flow signal Next.js
 * understands and handles silently. Expressing "this user still needs to
 * onboard" as a redirect rather than as an error is what makes the expected
 * path quiet, while leaving genuine failures — a database error inside
 * `getCurrentProfile()`, for instance — free to propagate and be reported.
 *
 * These run on the server. They are also not the only line of defence: Row
 * Level Security independently refuses to return another tenant's rows, so a
 * routing mistake here cannot become a data leak.
 */

export const SIGN_IN_PATH = '/sign-in';
export const ONBOARDING_PATH = '/onboarding';
/**
 * Where an account whose deletion has begun goes instead of MatchDay.
 *
 * Its own route rather than a banner on the dashboard, because there is nothing
 * on the dashboard such a person may do: every league surface refuses them, and
 * a page full of controls that all fail is worse than a page that explains why.
 */
export const ACCOUNT_DELETED_PATH = '/account/deleted';
export const DASHBOARD_PATH = '/dashboard';

/**
 * Why a redirect carries a notice code.
 *
 * Bouncing someone to the dashboard with no explanation reads as a broken link.
 * These codes let the dashboard say what happened. They are display hints only:
 * nothing is authorized from them, and a fabricated one can at most show the
 * wrong sentence to the person who fabricated it.
 */
export const DASHBOARD_NOTICES = {
  administrationTransferred: 'administration-transferred',
  notLeagueAdmin: 'not-league-admin',
  notLeagueMember: 'not-league-member',
  leftLeague: 'left-league',
} as const;

export type DashboardNotice = (typeof DASHBOARD_NOTICES)[keyof typeof DASHBOARD_NOTICES];

export function dashboardPathWithNotice(notice: DashboardNotice): string {
  return `${DASHBOARD_PATH}?notice=${notice}`;
}

/**
 * Notices shown on a match detail page after a redirect.
 *
 * Kept separate from `DASHBOARD_NOTICES` rather than bent to fit it: those
 * describe *losing* access and always land on the dashboard, whereas these
 * describe an action that succeeded and land back on the match. Sharing one
 * enum would make `dashboardPathWithNotice` lie about where it sends people.
 *
 * Display hints only. Nothing is authorized from them, and a fabricated value
 * shows the wrong sentence to whoever fabricated it and nobody else.
 */
export const MATCH_NOTICES = {
  saved: 'saved',
  notesSaved: 'notes-saved',
  notEditable: 'not-editable',
  // The two outcomes of the create form. They land on the match itself rather
  // than on the list, because "did that work, and is it live?" is a question
  // about this match and the match page is the only screen that answers it.
  published: 'published',
  draftSaved: 'draft-saved',
} as const;

export type MatchNotice = (typeof MATCH_NOTICES)[keyof typeof MATCH_NOTICES];

export function matchPath(slug: string, matchId: string): string {
  return `/leagues/${slug}/matches/${matchId}`;
}

export function matchPathWithNotice(
  slug: string,
  matchId: string,
  notice: MatchNotice,
): string {
  return `${matchPath(slug, matchId)}?notice=${notice}`;
}

export function parseMatchNotice(value: unknown): MatchNotice | null {
  return typeof value === 'string' && (Object.values(MATCH_NOTICES) as string[]).includes(value)
    ? (value as MatchNotice)
    : null;
}

export function parseDashboardNotice(value: unknown): DashboardNotice | null {
  return typeof value === 'string' &&
    (Object.values(DASHBOARD_NOTICES) as string[]).includes(value)
    ? (value as DashboardNotice)
    : null;
}

/** The signed-in user, or a clean redirect to sign-in. */
export async function requireSignedInUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (user === null) {
    redirect(SIGN_IN_PATH);
  }
  return user;
}

export interface OnboardedUser {
  user: SessionUser;
  profile: ProfileRow;
}

/**
 * The signed-in user together with their completed profile.
 *
 * Redirects to sign-in when there is no session, and to onboarding when the
 * profile does not exist yet. Both are expected states and neither is logged as
 * an error.
 *
 * Loop protection: `/onboarding` deliberately lives outside the `(app)` route
 * group, so the page this redirects to never re-enters this guard.
 * `tests/unit/page-guards.test.ts` asserts that placement.
 */
export async function requireOnboardedUser(): Promise<OnboardedUser> {
  const user = await requireSignedInUser();

  // A genuine failure inside getCurrentProfile() throws and is intentionally
  // not caught here: only a `null` result means "not onboarded yet".
  const profile = await getCurrentProfile();
  if (profile === null) {
    redirect(ONBOARDING_PATH);
  }

  // THREE STATES, THREE DESTINATIONS, and conflating any two of them is a bug
  // somebody would have to debug from a support email:
  //
  //     no profile row          -> onboarding
  //     profile, live           -> MatchDay
  //     profile, deleting/gone  -> the deletion-status screen
  //
  // This is why `profiles_select_self` is deliberately NOT gated on liveness in
  // the database. If a departing account could not read its own row,
  // `getCurrentProfile()` would return null, the branch above would fire, and
  // somebody halfway through deleting their account would be invited to create
  // a new profile — which the database would then refuse.
  if (isProfileDeleting(profile)) {
    redirect(ACCOUNT_DELETED_PATH);
  }

  return { user, profile };
}

export interface LeagueAdminPage {
  user: SessionUser;
  profile: ProfileRow;
  league: LeagueRow;
  membership: LeagueMembershipRow;
}

/**
 * Guard for the administrator-only league pages.
 *
 * `requireLeagueAdmin()` from `@/lib/auth/authorization` stays exactly as it is
 * and remains the check used by every server action — it throws
 * `NOT_LEAGUE_ADMIN`, which is right when a caller turns that into an
 * `ActionResult`. It is the wrong shape for a *render*: an ordinary error
 * escaping a Server Component is reported by Next.js as an unhandled
 * application error, which is what a demoted administrator saw after handing
 * over a league while still sitting on `/leagues/[slug]/members`.
 *
 * So this guard expresses the same rule as a redirect. It is not weaker: it
 * still requires an active `league_admin` membership, still derives the actor
 * from the session, and Row Level Security refuses the underlying rows
 * independently.
 *
 * An unknown slug and a league the caller merely plays in produce the *same*
 * redirect. A distinguishable answer would let anyone probe which private
 * leagues exist by URL.
 */
export async function requireLeagueAdminPage(slug: string): Promise<LeagueAdminPage> {
  const { user, profile } = await requireOnboardedUser();
  const entry = await findMyLeagueBySlug(slug);

  if (
    entry === null ||
    entry.membership.status !== 'active' ||
    entry.membership.role !== 'league_admin'
  ) {
    redirect(dashboardPathWithNotice(DASHBOARD_NOTICES.notLeagueAdmin));
  }

  return { user, profile, league: entry.league, membership: entry.membership };
}

export interface LeagueMemberPage {
  user: SessionUser;
  profile: ProfileRow;
  league: LeagueRow;
  membership: LeagueMembershipRow;
  isAdmin: boolean;
}

/**
 * Guard for member-facing league pages — guidelines, matches, match detail.
 *
 * Requires an **active** membership. Pending, suspended and removed members are
 * redirected, which is also what makes a notification deep link safe to hand
 * out: authorization is re-checked when the link is opened, so removing
 * somebody's membership immediately closes every old link they hold.
 *
 * An unknown slug, another tenant's slug and an inactive membership all produce
 * the same redirect, preserving the anti-enumeration behaviour Phase 2
 * established.
 */
export async function requireLeagueMemberPage(slug: string): Promise<LeagueMemberPage> {
  const { user, profile } = await requireOnboardedUser();
  const entry = await findMyLeagueBySlug(slug);

  if (entry === null || entry.membership.status !== 'active') {
    redirect(dashboardPathWithNotice(DASHBOARD_NOTICES.notLeagueMember));
  }

  return {
    user,
    profile,
    league: entry.league,
    membership: entry.membership,
    isAdmin: entry.membership.role === 'league_admin',
  };
}

/**
 * Guard for the onboarding page itself: requires a session, and sends users who
 * already have a profile on to the dashboard.
 */
export async function requireOnboardingCandidate(): Promise<SessionUser> {
  const user = await requireSignedInUser();

  if ((await getCurrentProfile()) !== null) {
    redirect(DASHBOARD_PATH);
  }

  return user;
}

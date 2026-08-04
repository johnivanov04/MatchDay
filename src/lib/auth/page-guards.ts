import 'server-only';

import { redirect } from 'next/navigation';
import { getCurrentProfile, getSessionUser, type SessionUser } from '@/lib/auth/session';
import type { ProfileRow } from '@/types/database';

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
export const DASHBOARD_PATH = '/dashboard';

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

  return { user, profile };
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

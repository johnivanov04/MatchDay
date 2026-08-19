import 'server-only';

import { cache } from 'react';
import { DomainError } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { ProfileRow } from '@/types/database';

export interface SessionUser {
  id: string;
  email: string;
}

/**
 * The signed-in user, or `null`.
 *
 * Uses `getUser()` rather than `getSession()`: `getSession()` reads the cookie
 * and trusts it, while `getUser()` revalidates the token with the Supabase auth
 * server. On the server, where the cookie is the only thing an attacker
 * controls, that difference is the whole point.
 *
 * Wrapped in React's `cache` so one render does not repeat the call.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();

  if (error !== null || data.user === null) {
    return null;
  }

  const { id, email } = data.user;
  if (typeof email !== 'string' || email === '') {
    // Matchday authenticates by email; a user without one cannot be resolved
    // to a profile.
    return null;
  }

  return { id, email: email.toLowerCase() };
});

/**
 * Whether an account has begun, or finished, deleting itself.
 *
 * ── DERIVED FROM STATE, NEVER FROM THE SCRUBBED NAME ───────────────────────
 *
 * The tombstone stores `first_name = 'Former'` because the column is NOT NULL
 * and something has to go there. Reading deletion state out of that string
 * would erase every real person called Former from every roster they ever
 * played on. The two timestamps are the fact; the name is a consequence.
 *
 * Both columns matter, and for different reasons. `deleted_at` alone would miss
 * the window between starting and finishing — which is exactly the window that
 * exists because Storage and GoTrue are not in the transaction.
 */
export function isProfileDeleting(profile: ProfileRow): boolean {
  // `?? null` rather than a bare `!== null`. A projection that has not selected
  // these columns yields `undefined`, which is not `null` — so the strict form
  // would read every such profile as mid-deletion and lock the entire product
  // behind the deletion-status screen. Failing towards "live" is right here
  // precisely because this is not the security boundary: the database refuses a
  // departing account independently, through `is_live_profile()`.
  return (profile.deletion_started_at ?? null) !== null || (profile.deleted_at ?? null) !== null;
}

/**
 * The signed-in user, or `AUTH_REQUIRED` — or `ACCOUNT_DELETED` if their
 * account is on its way out.
 *
 * ── WHY THE LIVENESS CHECK LIVES HERE ──────────────────────────────────────
 *
 * This is the guard seventeen server-action call sites already use, so putting
 * the check in it covers all of them at once rather than seventeen times, and
 * covers the eighteenth written next year for free.
 *
 * It is not the security boundary. The database refuses a departing account
 * through `is_live_profile()` in six predicates, five table guards and every
 * self-scoped policy — this is defence in depth and, more usefully, the thing
 * that turns a raw refusal into an error the interface can explain.
 *
 * The account-deletion actions themselves deliberately do NOT use this: they
 * call `getSessionUser()`, because refusing to let somebody finish deleting
 * their account on the grounds that they are deleting their account would be a
 * trap with no way out.
 */
export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (user === null) {
    throw new DomainError('AUTH_REQUIRED');
  }

  // Free after the first call in a request: `getCurrentProfile` is cached and
  // most callers load the profile anyway.
  const profile = await getCurrentProfile();
  if (profile !== null && isProfileDeleting(profile)) {
    throw new DomainError('ACCOUNT_DELETED');
  }

  return user;
}

/**
 * The current user's global profile, or `null`.
 *
 * `null` means exactly one thing: the user is signed in but has not completed
 * onboarding yet. That is an ordinary state, not a failure.
 *
 * A genuine query failure — connection lost, permission denied, schema drift —
 * is deliberately *not* collapsed into `null`. `maybeSingle()` already reports
 * "no row" as `data: null, error: null`, so an actual `error` means something
 * broke and must surface rather than silently masquerading as a user who has
 * not onboarded. Otherwise a database outage would quietly route every signed-in
 * user to `/onboarding` and invite them to re-create a profile they already have.
 */
export const getCurrentProfile = cache(async (): Promise<ProfileRow | null> => {
  const user = await getSessionUser();
  if (user === null) {
    return null;
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();

  if (error !== null) {
    throw new Error(`Failed to load the current user's profile: ${error.message}`, {
      cause: error,
    });
  }

  return data;
});

/**
 * The current user's profile, or `AUTH_REQUIRED` / `PROFILE_INCOMPLETE`.
 *
 * For **server actions and other non-rendering code**, where throwing a domain
 * error is the right control flow and the caller turns it into an `ActionResult`.
 *
 * Pages and layouts must use `requireOnboardedUser()` from
 * `@/lib/auth/page-guards` instead. Throwing `PROFILE_INCOMPLETE` during a
 * render is what produced a logged error stack for an entirely expected
 * onboarding state — see the note in that module.
 */
export async function requireCurrentProfile(): Promise<ProfileRow> {
  await requireSessionUser();
  const profile = await getCurrentProfile();
  if (profile === null) {
    throw new DomainError('PROFILE_INCOMPLETE');
  }
  return profile;
}

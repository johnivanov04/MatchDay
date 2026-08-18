import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthScreen } from '@/components/auth-screen';
import { ResetPasswordForm } from '@/components/reset-password-form';
import { safeRedirectPath } from '@/lib/auth/safe-redirect';
import { getSessionUser } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Set your password' };

/**
 * Where a recovery link lands.
 *
 * ── WHY THIS IS NOT INSIDE THE AUTHENTICATED LAYOUT ────────────────────────
 *
 * It needs a session, but not an *onboarded* one. `requireOnboardedUser` would
 * bounce a brand-new account to onboarding, and a historical passwordless
 * member arriving here is mid-recovery rather than mid-signup — neither should
 * be pushed through the profile form before being allowed to choose a password.
 * So the guard is the narrower one: a session, and nothing more.
 *
 * A session is genuinely required. Without it this is just a URL somebody
 * typed, and the action refuses too — the check exists twice because the page
 * decides what to render and the action decides what to do.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const nextPath = safeRedirectPath(typeof params['next'] === 'string' ? params['next'] : null);

  if ((await getSessionUser()) === null) {
    // Not "your link expired" — this page cannot tell the difference between an
    // expired link and somebody who navigated here directly, and the recovery
    // form is the right place for both.
    redirect('/forgot-password');
  }

  return (
    <AuthScreen
      title="Choose a password"
      description="This is the password you will use to sign in from now on."
    >
      <h2 className="text-lg font-bold">Set your password</h2>
      <ResetPasswordForm nextPath={nextPath} />
    </AuthScreen>
  );
}

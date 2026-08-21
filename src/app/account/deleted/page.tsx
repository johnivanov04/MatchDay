import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AccountDeletionStatus } from '@/components/account-deletion-status';
import { BrandLockup } from '@/components/ui/brand';
import { DASHBOARD_PATH, SIGN_IN_PATH } from '@/lib/auth/page-guards';
import { getCurrentProfile, getSessionUser, isProfileDeleting } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Account deletion' };

/**
 * Where an account whose deletion has begun lives out its remaining time.
 *
 * ── OUTSIDE THE `(app)` GROUP, ON PURPOSE ──────────────────────────────────
 *
 * That group's layout redirects here, so nesting this page inside it would
 * loop forever — the same reason `/onboarding` sits outside it. It also means
 * no app shell: no league strip, no tab bar, no inbox badge. There is nothing
 * in MatchDay this person may do, and rendering navigation to a dozen screens
 * that all refuse them would be worse than rendering none.
 *
 * ── THE FOUR WAYS SOMEBODY ARRIVES HERE ────────────────────────────────────
 *
 *   * signed out entirely — deletion finished and the session is gone;
 *   * signed in, deletion pending — Storage or the scrub did not complete;
 *   * signed in, tombstoned — the scrub committed but GoTrue did not, which is
 *     the state that still holds their real address in `auth.users`;
 *   * signed in and perfectly live — somebody typed the URL.
 *
 * Only the last is sent away. A signed-out visitor is shown the completed
 * message rather than bounced to sign-in, because "did that work?" is the one
 * question they have and a login form does not answer it.
 */
export default async function AccountDeletedPage() {
  const user = await getSessionUser();

  if (user === null) {
    return (
      <Shell>
        <AccountDeletionStatus state="signed-out" />
      </Shell>
    );
  }

  const profile = await getCurrentProfile();

  // A live account has no business here, and no message this page could show
  // would be true for them.
  if (profile === null || !isProfileDeleting(profile)) {
    redirect(DASHBOARD_PATH);
  }

  return (
    <Shell>
      <AccountDeletionStatus
        state={profile.deleted_at === null ? 'pending' : 'scrubbed'}
        signInPath={SIGN_IN_PATH}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main
      id="main"
      className="chalk-arc mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-6 pb-10 pt-[max(2.5rem,env(safe-area-inset-top))]"
    >
      <header className="animate-rise flex flex-col items-start gap-4">
        <BrandLockup size={34} />
      </header>
      {children}
    </main>
  );
}

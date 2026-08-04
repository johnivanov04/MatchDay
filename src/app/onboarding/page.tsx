import type { Metadata } from 'next';
import { ProfileForm } from '@/components/profile-form';
import { requireOnboardingCandidate } from '@/lib/auth/page-guards';

export const metadata: Metadata = { title: 'Set up your profile' };

/**
 * First-sign-in profile creation.
 *
 * Sits outside the `(app)` route group on purpose: that group's layout
 * redirects here when no profile exists, so nesting this page inside it would
 * loop forever.
 */
export default async function OnboardingPage() {
  const user = await requireOnboardingCandidate();

  return (
    <main id="main" className="mx-auto flex w-full max-w-md flex-col gap-6 px-5 py-10">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-pitch-600">Matchday</p>
        <h1 className="text-2xl font-bold">Set up your profile</h1>
        <p className="text-sm text-muted">
          Your name is all we need to start. Everything else is optional and can be added later.
        </p>
      </header>

      <ProfileForm profile={null} email={user.email} submitLabel="Continue" />
    </main>
  );
}

import type { Metadata } from 'next';
import { ProfileForm } from '@/components/profile-form';
import { BrandLockup } from '@/components/ui/brand';
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
    <main
      id="main"
      className="chalk-arc mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-6 pb-10 pt-[max(2.5rem,env(safe-area-inset-top))]"
    >
      <header className="animate-rise flex flex-col items-start gap-4">
        <BrandLockup size={34} />
        <div className="flex flex-col gap-2">
          {/* A one-step flow does not need a progress bar, but it does need to
              say that it is nearly over — "one more thing" is the difference
              between a form somebody finishes and a form that feels like the
              start of a long setup. */}
          <p className="text-[0.6875rem] font-bold uppercase tracking-[0.09em] text-pitch-700 dark:text-pitch-300">
            One more thing
          </p>
          <h1 className="text-[1.75rem] font-bold leading-tight">Set up your profile</h1>
          <p className="text-sm leading-relaxed text-secondary">
            Your name is all we need to start. Everything else is optional and can be added later.
          </p>
        </div>
      </header>

      <div className="animate-rise surface-panel p-5" style={{ animationDelay: '60ms' }}>
        <ProfileForm profile={null} email={user.email} submitLabel="Continue" />
      </div>
    </main>
  );
}

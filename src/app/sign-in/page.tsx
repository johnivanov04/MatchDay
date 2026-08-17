import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SignInForm } from '@/components/sign-in-form';
import { BrandLockup } from '@/components/ui/brand';
import { safeRedirectPath } from '@/lib/auth/safe-redirect';
import { getSessionUser } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // Sanitised here as well as in the auth callback: the value travels through
  // an emailed link, so it must be safe at every hop, not only the last one.
  const nextPath = safeRedirectPath(typeof params['next'] === 'string' ? params['next'] : null);

  if ((await getSessionUser()) !== null) {
    redirect(nextPath);
  }

  return (
    // The one screen with room for the theme to be visible: a full-height turf
    // wash with the centre circle bleeding off the top corner. Everywhere else
    // in the product the same motifs sit at 3% and are felt rather than seen —
    // here they are the first impression, so they are allowed to be seen.
    <main
      id="main"
      className="chalk-arc turf-stripes relative mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-6 py-12"
    >
      <header className="animate-rise flex flex-col items-start gap-4">
        <BrandLockup size={38} />
        <div className="flex flex-col gap-2">
          <h1 className="text-[2rem] font-bold leading-[1.1]">
            Sort the squad,
            <br />
            not the group chat.
          </h1>
          <p className="text-sm leading-relaxed text-secondary">
            One account for every league you play in. Matches, signup, teams and reminders in one
            place.
          </p>
        </div>
      </header>

      <div className="animate-rise surface-panel flex flex-col gap-4 p-5" style={{ animationDelay: '60ms' }}>
        {/* The panel is the sign-in form, so it gets a heading rather than
            floating unlabelled under a marketing line. It is also the only
            heading on the page that names the *task*, which is what a screen
            reader user navigating by heading is looking for. */}
        <h2 className="text-lg font-bold">Sign in</h2>
        <SignInForm nextPath={nextPath} />
      </div>
      {/* No footnote here. It read "No password. We email you a link and a
          one-time code." directly beneath a field hint saying "We will email
          you a sign-in link and a one-time code. No password needed." — the
          same sentence twice, forty pixels apart. The hint is the one that is
          attached to the control it describes, so the hint stays. */}
    </main>
  );
}

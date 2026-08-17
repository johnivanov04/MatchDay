import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { RedeemInviteForm } from '@/components/redeem-invite';
import { getCurrentProfile, getSessionUser } from '@/lib/auth/session';
import { isPlausibleInviteToken } from '@/lib/leagues/invite-token';

export const metadata: Metadata = { title: 'Join a league' };

/**
 * Invitation landing page.
 *
 * Deliberately outside the `(app)` route group: it must be reachable by someone
 * who has never signed in. A visitor without a session is sent to sign-in with
 * `next` pointing back here, so the link survives authentication; a signed-in
 * visitor without a profile finishes onboarding first, because a membership
 * needs a person attached to it.
 *
 * Nothing about the league is rendered before the token is redeemed. Showing
 * the name up front would turn a guessed token into a way to confirm that a
 * private league exists.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const user = await getSessionUser();
  if (user === null) {
    redirect(`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`);
  }

  if ((await getCurrentProfile()) === null) {
    redirect('/onboarding');
  }

  const usable = isPlausibleInviteToken(token);

  return (
    <main id="main" className="mx-auto flex w-full max-w-md flex-col gap-6 px-5 py-12">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-pitch-600">MatchDay</p>
        <h1 className="text-2xl font-bold">You have been invited</h1>
        <p className="text-sm text-muted">
          Accepting adds this league to your account. You keep one profile across every league you
          play in.
        </p>
      </header>

      {usable ? (
        <RedeemInviteForm token={token} />
      ) : (
        <p
          role="alert"
          className="rounded-lg border border-whistle-200 bg-whistle-50 px-3 py-2 text-sm text-red-800 dark:border-whistle-900 dark:bg-whistle-900/25 dark:text-red-200"
        >
          That invitation link is not valid or has expired.
        </p>
      )}
    </main>
  );
}

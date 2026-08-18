import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthScreen } from '@/components/auth-screen';
import { SignInForm } from '@/components/sign-in-form';
import { safeRedirectPath } from '@/lib/auth/safe-redirect';
import { getSessionUser } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // Sanitised here as well as in every action that reads it back: the value
  // travels through an emailed link, so it must be safe at every hop rather
  // than only the last one.
  const nextPath = safeRedirectPath(typeof params['next'] === 'string' ? params['next'] : null);

  // Somebody already signed in has no business on this page — and if they
  // arrived here from an invitation link, `next` is where they were going.
  if ((await getSessionUser()) !== null) {
    redirect(nextPath);
  }

  return (
    <AuthScreen
      title={
        <>
          Sort the squad,
          <br />
          not the group chat.
        </>
      }
      description="One account for every league you play in. Matches, signup, teams and reminders in one place."
    >
      {/* The heading names the *task*, which is what a screen-reader user
          navigating by heading is looking for — the one above is the product. */}
      <h2 className="text-lg font-bold">Sign in</h2>
      <SignInForm nextPath={nextPath} />
    </AuthScreen>
  );
}

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthScreen } from '@/components/auth-screen';
import { SignUpForm } from '@/components/sign-up-form';
import { safeRedirectPath } from '@/lib/auth/safe-redirect';
import { getSessionUser } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Create account' };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const nextPath = safeRedirectPath(typeof params['next'] === 'string' ? params['next'] : null);

  if ((await getSessionUser()) !== null) {
    redirect(nextPath);
  }

  return (
    <AuthScreen
      title="Create your account"
      description="Your email and a password. We will send one message to confirm the address, and that is the last one you need."
    >
      <h2 className="text-lg font-bold">Create account</h2>
      <SignUpForm nextPath={nextPath} />
    </AuthScreen>
  );
}

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SignInForm } from '@/components/sign-in-form';
import { getSessionUser } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage() {
  if ((await getSessionUser()) !== null) {
    redirect('/dashboard');
  }

  return (
    <main id="main" className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-5 py-12">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-pitch-600">Matchday</p>
        <h1 className="text-2xl font-bold">Sign in</h1>
        <p className="text-sm text-muted">
          One account for every league you play in.
        </p>
      </header>

      <SignInForm />
    </main>
  );
}

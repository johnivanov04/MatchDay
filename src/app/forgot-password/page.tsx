import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthScreen } from '@/components/auth-screen';
import { ForgotPasswordForm } from '@/components/forgot-password-form';
import { getSessionUser } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Reset your password' };

/**
 * One screen for two groups of people.
 *
 * Somebody who has forgotten their password, and somebody who has never had one
 * — every MatchDay member who joined while the product was passwordless. Both
 * need the same thing: a verified email and a screen that asks for a new
 * password. The copy says so, because "Forgot your password?" reads as "not for
 * me" to the second group and they would never press it.
 */
export default async function ForgotPasswordPage() {
  if ((await getSessionUser()) !== null) {
    redirect('/profile');
  }

  return (
    <AuthScreen
      title="Set a new password"
      description="Whether you have forgotten your password or never set one, this is the way in."
    >
      <h2 className="text-lg font-bold">Forgot or don&rsquo;t have a password?</h2>
      <ForgotPasswordForm />
    </AuthScreen>
  );
}

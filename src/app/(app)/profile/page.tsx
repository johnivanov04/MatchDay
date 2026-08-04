import type { Metadata } from 'next';
import { ProfileForm } from '@/components/profile-form';
import { requireOnboardedUser } from '@/lib/auth/page-guards';

export const metadata: Metadata = { title: 'Your profile' };

export default async function ProfilePage() {
  const { user, profile } = await requireOnboardedUser();

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Your profile</h1>
        <p className="text-sm text-muted">
          One profile, shared across every league you belong to.
        </p>
      </header>

      <ProfileForm profile={profile} email={user.email} submitLabel="Save changes" />
    </>
  );
}

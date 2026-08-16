import type { Metadata } from 'next';
import { AvatarPicker } from '@/components/avatar-picker';
import { ProfileForm } from '@/components/profile-form';
import { requireOnboardedUser } from '@/lib/auth/page-guards';
import { avatarImageUrl, avatarInitials, avatarLabel } from '@/lib/profile/avatar';

export const metadata: Metadata = { title: 'Your profile' };

export default async function ProfilePage() {
  const { user, profile } = await requireOnboardedUser();

  // Resolved on the server so the correct face is in the first HTML response
  // rather than appearing after hydration.
  const currentSrc = avatarImageUrl(profile);

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Your profile</h1>
        <p className="text-sm text-muted">
          One profile, shared across every league you belong to.
        </p>
      </header>

      <section aria-labelledby="photo-heading" className="flex flex-col gap-3">
        <h2 id="photo-heading" className="sr-only">
          Profile photo
        </h2>
        <AvatarPicker
          currentSrc={currentSrc}
          initials={avatarInitials(profile.first_name, profile.last_name)}
          label={avatarLabel(profile.first_name, profile.last_name)}
        />
      </section>

      <ProfileForm profile={profile} email={user.email} submitLabel="Save changes" />
    </>
  );
}

import type { Metadata } from 'next';
import { AvatarPicker } from '@/components/avatar-picker';
import { ChangePassword } from '@/components/change-password';
import { DeleteAccount } from '@/components/delete-account';
import { ProfileForm } from '@/components/profile-form';
import { ButtonLink } from '@/components/ui/button';
import { Card, Section } from '@/components/ui/card';
import { BellIcon, ChevronRightIcon, LogOutIcon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';
import { requireOnboardedUser } from '@/lib/auth/page-guards';
import { avatarImageUrl, avatarInitials, avatarLabel } from '@/lib/profile/avatar';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AccountDeletionBlocker } from '@/types/database';

export const metadata: Metadata = { title: 'Your profile' };

/**
 * The account hub.
 *
 * ── WHY THIS IS MORE THAN A FORM NOW ───────────────────────────────────────
 *
 * Sign-out lived in the global header and notification settings lived behind a
 * text link called "Alerts" in a row of six others. Both are account concerns
 * and neither is something anybody does more than once in a while, so both took
 * permanent space on every screen while being hard to find on purpose.
 *
 * They live here, which is the fourth bottom tab and where anybody would look
 * for them. The header keeps the avatar as the way in.
 */
export default async function ProfilePage() {
  const { user, profile } = await requireOnboardedUser();

  // The open leagues this person administers, and therefore cannot delete their
  // account while they run. Fetched here rather than inside the dialog so the
  // blocked case is decided on the server — the client never gets to conclude
  // it is allowed to proceed, and `begin_my_account_deletion` re-derives the
  // same fact inside its own transaction regardless.
  const supabase = await createSupabaseServerClient();
  const { data: blockerRows } = await supabase.rpc('my_account_deletion_blockers');
  const blockers: AccountDeletionBlocker[] = blockerRows ?? [];

  // Resolved on the server so the correct face is in the first HTML response
  // rather than appearing after hydration.
  const currentSrc = avatarImageUrl(profile);

  return (
    <>
      <PageHeader
        title="Your profile"
        description="One profile, shared across every league you belong to."
      />

      <section aria-labelledby="photo-heading" className="animate-rise">
        <h2 id="photo-heading" className="sr-only">
          Profile photo
        </h2>
        <div className="chalk-arc surface-panel turf-stripes flex flex-col items-center gap-4 overflow-hidden p-6">
          <AvatarPicker
            currentSrc={currentSrc}
            initials={avatarInitials(profile.first_name, profile.last_name)}
            label={avatarLabel(profile.first_name, profile.last_name)}
          />
          <div className="flex flex-col items-center gap-0.5 text-center">
            <p className="text-lg font-bold leading-tight">
              {profile.first_name} {profile.last_name}
            </p>
            <p className="text-sm text-muted">{user.email}</p>
          </div>
        </div>
      </section>

      <Section title="Your details" description="Only your league administrator sees the optional fields.">
        <Card className="p-4">
          <ProfileForm profile={profile} email={user.email} submitLabel="Save changes" />
        </Card>
      </Section>

      <Section title="Account">
        <Card className="overflow-hidden p-0">
          <ul className="divide-hairline flex flex-col">
            <li>
              <ChangePassword />
            </li>
            <li>
              <ButtonLink
                href="/settings/devices"
                variant="ghost"
                className="w-full justify-start gap-3 rounded-none px-4 py-3.5 text-left"
              >
                <span
                  aria-hidden="true"
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-pitch-50 text-pitch-700 dark:bg-pitch-900/50 dark:text-pitch-300"
                >
                  <BellIcon size={18} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-semibold text-[var(--text-primary)]">
                    Phone notifications
                  </span>
                  <span className="truncate text-xs font-normal text-muted">
                    Match alerts when MatchDay is closed
                  </span>
                </span>
                <ChevronRightIcon size={16} className="text-muted" />
              </ButtonLink>
            </li>
            <li>
              {/* A real form post, not a link: signing out is a state change, and
                  a GET that ends a session is a request any prefetcher can make
                  on somebody's behalf. */}
              <form action="/auth/sign-out" method="post">
                <button
                  type="submit"
                  className="press flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-[var(--surface-hover)]"
                >
                  <span
                    aria-hidden="true"
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-whistle-50 text-whistle-700 dark:bg-whistle-900/40 dark:text-whistle-200"
                  >
                    <LogOutIcon size={18} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">Sign out</span>
                  <ChevronRightIcon size={16} className="text-muted" />
                </button>
              </form>
            </li>
          </ul>
        </Card>
      </Section>

      {/* ── Deleting the account ──────────────────────────────────────────────
          Its own section below the rest, separated rather than sitting as a
          fifth row under Sign out. Everything above is reversible; this is not,
          and the two should not read as the same kind of thing.

          Apple requires an app that creates accounts to offer deletion from
          inside the app — not an instruction to email support — which is why
          this is a control and not a paragraph. */}
      <Section
        title="Delete account"
        description="Permanently remove your MatchDay account and personal details."
      >
        <Card className="overflow-hidden p-0">
          <DeleteAccount blockers={blockers} />
        </Card>
      </Section>
    </>
  );
}

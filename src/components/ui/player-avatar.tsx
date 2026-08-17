import { Avatar } from '@/components/ui/avatar';
import { avatarInitials, avatarLabel, managedAvatarUrl } from '@/lib/profile/avatar';

/**
 * Another member's face, next to their name.
 *
 * ── ONE PLACE THAT KNOWS HOW TO BUILD AN AVATAR URL ────────────────────────
 *
 * Nine surfaces render other players. If each resolved its own URL there would
 * be nine chances to concatenate an unvalidated column into an `<img src>`,
 * nine places to forget that a malformed path must become initials, and nine
 * things to change the day the bucket or the object route moves. So every one
 * of them renders this, and this is the only component that calls
 * `managedAvatarUrl`.
 *
 * ── WHAT IT DELIBERATELY CANNOT DO ─────────────────────────────────────────
 *
 * The prop type admits **three fields**: two names and an object key. There is
 * no `profile_photo_url` and no way to pass one, which is what makes "a legacy
 * address never renders in another member's browser" a property of the type
 * system rather than a convention nine call sites have to remember. A legacy
 * address points at a host nobody here controls; rendering it for somebody else
 * would disclose their IP and user agent to whoever runs it.
 *
 * That holds for the caller's own row inside a roster too. `avatarImageUrl` in
 * `@/lib/profile/avatar` is the self-profile resolver and is the only one that
 * falls back to a legacy address.
 *
 * Not a server component and not a client component: it renders no state and
 * no handlers, so it works in either, and the `'use client'` boundary is where
 * it belongs — inside `Avatar`, which owns the broken-image fallback.
 */

/** Exactly what an avatar needs. Everything else is somebody else's business. */
export interface PlayerIdentity {
  first_name: string;
  last_name: string;
  profile_photo_path: string | null;
}

export function PlayerAvatar({
  player,
  size = 32,
  className,
}: {
  player: PlayerIdentity;
  /** Rendered edge length. 24 for dense lists, 32 for rows, 36 for cards. */
  size?: number;
  className?: string;
}) {
  return (
    <Avatar
      src={managedAvatarUrl(player.profile_photo_path)}
      initials={avatarInitials(player.first_name, player.last_name)}
      label={avatarLabel(player.first_name, player.last_name)}
      size={size}
      // A roster is twenty of these below the fold on a phone. Lazy is right for
      // a list and wrong for the one avatar at the top of your own profile,
      // which is why it is a prop on `Avatar` rather than a default.
      loading="lazy"
      {...(className === undefined ? {} : { className })}
    />
  );
}

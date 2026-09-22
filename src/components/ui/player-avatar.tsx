import { Avatar } from '@/components/ui/avatar';
import { avatarInitials, avatarLabel } from '@/lib/profile/avatar';

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
 *
 * ── IT RENDERS INITIALS, NOT PHOTOGRAPHS. THAT IS THE POINT. ───────────────
 *
 * A profile photo is a user-uploaded image and nothing moderates it. App Review
 * Guideline 1.2 asks that objectionable material not be distributed, and an
 * unmoderated photograph shown to twenty other members on a roster is exactly
 * that — the one piece of user content here that a text filter cannot read.
 *
 * So this renders initials for everybody. The member-facing projections already
 * return `profile_photo_path` as null for anybody but the viewer, which stops
 * the path being transmitted at all; this stops it being rendered even if a
 * future query forgets. Two independent guarantees, because "we filter it in
 * the query" is one refactor away from being false.
 *
 * A member's own photo still exists and still appears on their own profile,
 * where the only person who sees it is the person who chose it. Nothing was
 * deleted. `PlayerIdentity` keeps `profile_photo_path` so call sites and the
 * projections need not change shape, and so restoring photographs later is a
 * change to this file rather than to nine others — once something moderates
 * them.
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
      src={null}
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

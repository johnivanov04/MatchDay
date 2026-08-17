'use client';

import { useState } from 'react';

/**
 * A member's face, or their initials.
 *
 * ── THE INITIALS ARE THE FLOOR, NOT THE FALLBACK ───────────────────────────
 *
 * They are always rendered, underneath. The image is a layer on top that either
 * paints or does not. Nothing here ever shows an empty circle while a photo
 * loads, and nothing ever shows a browser's broken-image glyph: a failed load
 * removes the layer and what was already behind it stays.
 *
 * That matters more than it sounds. Avatars come from two places — a public
 * Supabase Storage object and, on legacy profiles, an arbitrary address
 * somebody pasted years ago that may 404, may have moved behind a login, or may
 * simply be gone. A broken-image icon on a roster reads as a bug in Matchday.
 *
 * ── WHY A PLAIN <img> ──────────────────────────────────────────────────────
 *
 * `next/image` needs every remote host declared in `next.config.ts`. Managed
 * avatars would be fine — one known Supabase origin — but legacy URLs point
 * anywhere on the internet and cannot be allowlisted even in principle. One
 * component that handles both beats two that each handle half, and these are
 * 512x512 JPEGs of ~50 KB that need no further optimization.
 */

export interface AvatarProps {
  /** Resolved image URL, or `null` for initials only. */
  src: string | null;
  /** One or two letters. See `avatarInitials`. */
  initials: string;
  /** Who this is, e.g. "Sam Okafor". Used to build the accessible name. */
  label: string;
  /** Rendered edge length in pixels. */
  size?: number;
  /**
   * `'lazy'` for a list, where twenty faces sit below the fold on a phone and
   * fetching them all on paint costs bandwidth nobody is looking at yet.
   *
   * Defaults to eager, because the one avatar that matters most — the player's
   * own, at the top of their profile — is above the fold and deferring it would
   * make the page appear to load its own face last.
   */
  loading?: 'lazy' | 'eager';
  className?: string;
}

export function Avatar({
  src,
  initials,
  label,
  size = 96,
  loading = 'eager',
  className = '',
}: AvatarProps) {
  // Keyed by URL rather than a boolean, so swapping in a new photo after a
  // failed one re-attempts the load instead of staying stuck on initials.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = src !== null && src !== '' && src !== failedSrc;

  const dimension = `${String(size)}px`;
  // Scales with the circle so one component works at 32px on a roster row and
  // at 128px on the profile page.
  const fontSize = `${String(Math.round(size * 0.4))}px`;

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-pitch-100 text-pitch-900 dark:bg-pitch-900 dark:text-pitch-50 ${className}`}
      style={{ width: dimension, height: dimension }}
      // When there is no photo the circle *is* the content, so it carries the
      // accessible name itself. With a photo the <img> below carries it and
      // this becomes decorative, avoiding the name being announced twice.
      {...(showImage ? {} : { role: 'img', 'aria-label': `${label}, no profile photo` })}
    >
      <span
        aria-hidden="true"
        className="select-none font-semibold leading-none tracking-tight"
        style={{ fontSize }}
      >
        {initials}
      </span>

      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- see the note above: legacy avatars are arbitrary remote hosts that next/image cannot allowlist.
        <img
          src={src}
          alt={`${label}, profile photo`}
          width={size}
          height={size}
          loading={loading}
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => {
            setFailedSrc(src);
          }}
        />
      ) : null}
    </span>
  );
}

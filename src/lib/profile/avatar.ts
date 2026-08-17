import { getPublicEnv } from '@/lib/env';

/**
 * Where an avatar comes from, and what shape a Matchday-managed one has.
 *
 * Imported by the browser, by Server Components and by the upload action, so it
 * carries no `server-only` marker and reaches for nothing that is unavailable
 * in a browser bundle. Every limit below is stated once here and read from both
 * sides, because a client that resizes to one budget and a server that enforces
 * another is a bug waiting for a slow phone.
 */

/** The public Supabase Storage bucket holding Matchday-managed avatars. */
export const AVATAR_BUCKET = 'avatars';

/**
 * The largest file the picker will even attempt to decode.
 *
 * A modern phone camera produces 3–8 MB, so this accepts an ordinary photo and
 * refuses a 60 MB panorama before it is read into memory. **This file is never
 * uploaded** — it is decoded, cropped and re-encoded first, and only the result
 * leaves the device.
 */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

/** Edge length of the stored square, in device pixels. */
export const AVATAR_DIMENSION = 512;

/** JPEG quality for the re-encode. Visually clean at this size; ~40–60 KB. */
export const AVATAR_JPEG_QUALITY = 0.82;

/**
 * The hard cap on the processed JPEG, enforced on both sides.
 *
 * Well above what 512x512 at q0.82 produces, and well below Next.js's 1 MB
 * default Server Action body limit — which is deliberately left alone, so this
 * ceiling is what keeps a request from being rejected by the framework with an
 * error nobody can act on.
 */
export const MAX_PROCESSED_BYTES = 750 * 1024;

/** The only content type the bucket, the action and the encoder agree on. */
export const AVATAR_CONTENT_TYPE = 'image/jpeg';

/** Form field carrying the processed image. Read by the upload action. */
export const AVATAR_FILE_FIELD = 'avatar';

/**
 * `{uuid}.jpg`, lower-case, anchored.
 *
 * Mirrors `profiles_photo_path_shape` in
 * `20260818090100_profile_photo_path.sql`. The database is the authority; this
 * exists so the application can refuse a malformed value before asking Storage
 * to delete something based on it.
 */
const MANAGED_FILENAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

/**
 * True when `path` is an object this product wrote, for this exact user.
 *
 * ── THIS IS A SAFETY CHECK, NOT A FORMATTING CHECK ─────────────────────────
 *
 * It is the gate in front of every Storage deletion. `profile_photo_url` may
 * hold an arbitrary legacy address pointing anywhere on the internet, and the
 * one thing that must never happen is a delete call built from a value that did
 * not come out of `profile_photo_path`. Requiring the owner's id as the first
 * segment means a deletion can only ever target the caller's own folder, even
 * if a row were somehow written with somebody else's path.
 */
export function isManagedAvatarPath(path: string | null | undefined, ownerId: string): boolean {
  if (typeof path !== 'string' || path === '') {
    return false;
  }

  const segments = path.split('/');
  return (
    segments.length === 2 && segments[0] === ownerId && MANAGED_FILENAME.test(segments[1] ?? '')
  );
}

/** The owner folder: a lower-case uuid, and nothing else. */
const MANAGED_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * True when `path` has the shape of a Matchday-managed object — **whoever owns
 * it**.
 *
 * ── WHY THIS EXISTS ALONGSIDE `isManagedAvatarPath` ────────────────────────
 *
 * The two answer different questions and must not be merged.
 *
 *   * `isManagedAvatarPath(path, ownerId)` asks *may I delete this?* It needs
 *     the owner's auth user id, because a deletion built from the wrong value
 *     destroys somebody else's photo. It is the gate in front of every Storage
 *     removal and it stays exactly as strict as it is.
 *
 *   * this one asks *may I render this?* It is used on paths that arrived from
 *     a SECURITY DEFINER projection, where the row is another member's and the
 *     caller has no business knowing their user id — the projections return
 *     `membership_id` and deliberately no `user_id`.
 *
 * Dropping the ownership check costs nothing here, because
 * `profiles_photo_path_shape` already guarantees in the database that the first
 * segment **is** that profile's id. So a path reaching this function is
 * trustworthy by construction, and the shape check that remains is what stops a
 * malformed or hostile value being concatenated into a URL.
 */
function isWellFormedAvatarPath(path: string): boolean {
  const segments = path.split('/');
  return (
    segments.length === 2 &&
    MANAGED_FOLDER.test(segments[0] ?? '') &&
    MANAGED_FILENAME.test(segments[1] ?? '')
  );
}

/** The public URL Supabase Storage serves a bucket object from. */
export function avatarPublicUrl(path: string): string {
  const { supabaseUrl } = getPublicEnv();
  const origin = supabaseUrl.replace(/\/+$/, '');
  return `${origin}/storage/v1/object/public/${AVATAR_BUCKET}/${path}`;
}

/**
 * The image URL for a projected avatar path, or `null`.
 *
 * ── THE ONLY WAY A COMPONENT TURNS A PATH INTO A URL ───────────────────────
 *
 * Every other-player surface goes through here, so URL construction lives in
 * one place and a change of bucket, origin or object route is a change to one
 * function rather than to nine components.
 *
 * Anything that is not exactly `{uuid}/{uuid}.jpg` returns `null` and the
 * caller renders initials. That covers the obvious malformed cases and the
 * dangerous ones equally: a full `https://…` URL, a protocol-relative `//host`,
 * a traversal, a nested key, an extra segment or a swapped extension all fail
 * the same way, so none of them can be spliced into the address an `<img>` is
 * pointed at.
 *
 * **This never sees `profile_photo_url`.** Legacy addresses are not returned by
 * any projection and render only on their owner's own profile page, through
 * `avatarImageUrl` below.
 */
export function managedAvatarUrl(path: string | null | undefined): string | null {
  if (typeof path !== 'string' || path === '' || !isWellFormedAvatarPath(path)) {
    return null;
  }
  return avatarPublicUrl(path);
}

/** The two photo columns, as much of a profile as any avatar decision needs. */
export interface AvatarSource {
  id: string;
  profile_photo_path: string | null;
  profile_photo_url: string | null;
}

/**
 * The image to render for **the signed-in user's own profile**, or `null`.
 *
 * The priority is fixed and documented in the migration:
 *
 *   1. a Matchday-managed object, resolved to its public Storage URL;
 *   2. a legacy external address, rendered exactly as it was stored;
 *   3. nothing.
 *
 * ── SELF ONLY. USE `managedAvatarUrl` FOR ANYBODY ELSE ─────────────────────
 *
 * Step 2 is the reason for the distinction. A legacy address points at a host
 * nobody here controls, and rendering it inside another member's browser would
 * disclose that member's IP address and user agent to whoever runs it, on a
 * page they never chose to visit. So legacy addresses stay on their owner's own
 * profile, where the request is one the owner is already making.
 *
 * That rule is **not** conditional on `is_self`: no projection returns
 * `profile_photo_url` at all, so a roster row for the caller themselves renders
 * initials if their only photo is a legacy one. The inconsistency is accepted
 * and is fixed by one upload; a conditional invariant would be correct today
 * and wrong two phases from now.
 *
 * A managed path that fails `isManagedAvatarPath` is ignored rather than
 * rendered, and falls through to the legacy value. That can only happen if a
 * row was written outside the constraint, which is to say never — but "render
 * a URL assembled from an unvalidated column" is not a thing worth leaving
 * possible.
 */
export function avatarImageUrl(profile: AvatarSource | null): string | null {
  if (profile === null) {
    return null;
  }

  if (isManagedAvatarPath(profile.profile_photo_path, profile.id)) {
    return avatarPublicUrl(profile.profile_photo_path as string);
  }

  const legacy = profile.profile_photo_url;
  return typeof legacy === 'string' && legacy !== '' ? legacy : null;
}

/**
 * One or two letters standing in for a face.
 *
 * Falls back to `?` rather than an empty circle, because a blank disc reads as
 * a failed image and this is a deliberate state.
 */
export function avatarInitials(firstName: string | null, lastName: string | null): string {
  const first = (firstName ?? '').trim();
  const last = (lastName ?? '').trim();

  // `[...string]` rather than `charAt`, so a name beginning with an emoji or an
  // astral-plane character yields that character instead of half of it.
  const initials = `${[...first][0] ?? ''}${[...last][0] ?? ''}`.trim();
  return initials === '' ? '?' : initials.toUpperCase();
}

/** "Sam Okafor" for alt text and screen readers; "your photo" when unknown. */
export function avatarLabel(firstName: string | null, lastName: string | null): string {
  const full = `${(firstName ?? '').trim()} ${(lastName ?? '').trim()}`.trim();
  return full === '' ? 'this member' : full;
}

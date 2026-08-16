-- Matchday — Matchday-managed profile photos
-- `profiles.profile_photo_path`: the object key of an avatar this product owns.
--
-- ── WHY A SECOND COLUMN RATHER THAN REUSING THE FIRST ──────────────────────
--
-- `profile_photo_url` has been writable since Phase 1 and its only constraint
-- is `^https://`. Existing rows may therefore hold an arbitrary address on a
-- host nobody here controls. That makes it unsafe as the source of truth for an
-- uploaded avatar, for one specific reason: **cleanup**. Replacing or removing a
-- photo has to delete the previous object, and code that derived an object key
-- by parsing a URL out of that column would, on a legacy row, be parsing a
-- stranger's URL and then asking Storage to delete whatever fell out of it.
--
-- Two columns make that mistake unrepresentable. `profile_photo_path` holds
-- **only** keys this product wrote, in a shape the database itself verifies, so
-- "is this safe to delete?" is answered by which column the value came from
-- rather than by a runtime guess. Nothing ever deletes based on
-- `profile_photo_url`.
--
-- ── RENDERING PRIORITY ─────────────────────────────────────────────────────
--
--   1. `profile_photo_path`  → public Storage URL, derived at render time
--   2. `profile_photo_url`   → legacy external address, rendered as-is
--   3. neither               → initials
--
-- A successful managed upload sets the path and clears the legacy URL, so the
-- two are never both populated by anything this product does. The order above
-- is still defined for both, because a legacy row is not something to trust to
-- stay tidy.
--
-- ── THE CONSTRAINT IS THE POINT ────────────────────────────────────────────
--
-- The server generates the path from the verified session and a server-side
-- uuid, and the Storage policies independently confine writes to the caller's
-- own folder. This constraint is the third, independent layer: even a row
-- written by service-role maintenance code cannot record a path that points at
-- another member's folder, at a nested key, or at a non-JPEG.
--
-- Written as four separate conditions rather than one clever regular
-- expression, because each one is a distinct requirement and a failure should
-- say which was violated when read back in a test.

alter table public.profiles
  add column profile_photo_path text;

alter table public.profiles
  add constraint profiles_photo_path_shape check (
    profile_photo_path is null
    or (
      -- Exactly two segments: the owner's folder and one filename. No nesting,
      -- no bare filename, no trailing slash.
      --
      -- `cardinality`, NOT `array_length(..., 1)`. For the empty string
      -- `string_to_array` returns an empty array, whose `array_length` is NULL
      -- rather than 0 — so the comparison yields NULL, the whole conjunct
      -- yields NULL, and a CHECK that evaluates to NULL is **satisfied**.
      -- Written the other way this constraint accepted `''`, which is neither
      -- a path nor an absence of one. `cardinality` returns 0 for an empty
      -- array and never NULL, so the expression stays total.
      cardinality(string_to_array(profile_photo_path, '/')) = 2

      -- The folder is this row's own id. A path under anybody else's folder is
      -- rejected by the database regardless of who is writing it.
      and (string_to_array(profile_photo_path, '/'))[1] = id::text

      -- The filename is a lower-case uuid with a `.jpg` extension, which is
      -- exactly what `crypto.randomUUID()` produces on the server. Anchored at
      -- both ends, so `<uuid>.jpg.html` and `../<uuid>.jpg` are both refused.
      and (string_to_array(profile_photo_path, '/'))[2] ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'
    )
  );

comment on column public.profiles.profile_photo_path is
  'Object key of a Matchday-managed avatar in the public `avatars` bucket, '
  'always `{profiles.id}/{uuid}.jpg`. Safe to delete from Storage; '
  'profile_photo_url is not.';

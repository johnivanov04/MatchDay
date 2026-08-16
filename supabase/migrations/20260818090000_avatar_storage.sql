-- Matchday — profile photo storage
-- The `avatars` bucket, and who may touch an object in it.
--
-- ── WHY A BUCKET AT ALL ────────────────────────────────────────────────────
--
-- `profiles.profile_photo_url` has existed since Phase 1 and accepts any https
-- URL, which meant the only way to have a profile photo was to paste a link to
-- one hosted somewhere else. This is where the file itself lives now. That
-- column is left alone for backwards compatibility; the new column recording a
-- Matchday-managed object is added in the migration alongside this one.
--
-- ── PUBLIC BUCKET, PRIVATE METADATA ────────────────────────────────────────
--
-- Two different things are being decided here, and conflating them is how this
-- was wrong the first time:
--
--   * **Object retrieval** is public. `public = true` makes the Storage service
--     serve `/storage/v1/object/public/avatars/<path>` to anybody, without
--     consulting Row Level Security at all. That is the whole point — a face
--     renders from a plain <img> tag, cacheable by the CDN and by the service
--     worker, with no per-render signed URL.
--
--   * **Row visibility in `storage.objects`** is not public, and there is no
--     reason for it to be. A broad `for select ... to anon, authenticated`
--     policy would add nothing to retrieval (which never reads these rows) and
--     would hand every visitor a listable index of every avatar path in the
--     product — who has uploaded one, how often they change it, and a URL for
--     each. So SELECT is scoped to the caller's own folder, exactly like INSERT
--     and DELETE.
--
-- The accepted trade is stated plainly: anyone **holding** an object's URL can
-- fetch it, including after the player removes it, until the object is deleted.
-- The path contains a random uuid, so a URL is unguessable and cannot be
-- enumerated through this table — but it is not a secret.
--
-- ── PATHS ARE `{auth.uid()}/{uuid}.jpg`, AND THAT IS THE AUTHORIZATION ──────
--
-- The first path segment is the owner. Every policy below compares it against
-- `auth.uid()`, so a caller can only ever reach inside their own folder. There
-- is no user id in any form field to forge, because the path is derived from
-- the session on the server.
--
-- The uuid makes each upload a new object rather than an overwrite. Overwriting
-- a fixed name like `avatar.jpg` is the classic way to serve a stale face from
-- a CDN for hours; a fresh path cannot be stale. It also makes replacement
-- recoverable — the profile keeps pointing at the old object until the new one
-- is committed — and the old object is deleted afterwards by the application.
--
-- There is deliberately **no UPDATE policy**. Uploads always write a new uuid
-- and the application never upserts, so the ability to modify an existing
-- object is capability nobody needs. Its absence is what makes
-- "overwrite is impossible" a property of the database rather than a promise
-- about application code.

-- ── The bucket ─────────────────────────────────────────────────────────────
--
-- Idempotent: this migration must survive `db reset` and re-application, and a
-- bucket that already exists should be brought to these settings rather than
-- raising.
--
-- `image/jpeg` alone. The client converts every selection to JPEG before
-- uploading — one stored format keeps the server-side magic-byte check to a
-- single signature, and an allowlist of one is the narrowest thing that can be
-- served from a domain we do not control. A bucket that accepted `text/html`
-- would be a stored-XSS vector on the Supabase origin.
--
-- 1 MiB. A 512x512 JPEG at quality 0.82 is roughly 40-60 KB and the application
-- refuses anything over 750 KiB before it ever reaches Storage, so this is the
-- backstop rather than the working limit: comfortably above any real avatar,
-- far below anything that would make this useful as general file storage.
--
-- NOTE both of these are enforced by the Storage **service**, not by the
-- database. A direct SQL insert into `storage.objects` bypasses them by design,
-- which is why they are covered by tests that speak HTTP to a running stack
-- (`tests/storage/avatar-storage-api.test.ts`) rather than by a policy test.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 1048576, array['image/jpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- ── Policies ───────────────────────────────────────────────────────────────
--
-- `storage.objects` already has row level security enabled by Supabase, so
-- nothing here enables or forces it — and nothing here touches `public.profiles`
-- or any existing policy.
--
-- Dropped first so the migration is idempotent (`create policy` has no
-- `if not exists`). The two names that are dropped but never recreated —
-- `avatars_read_public` and `avatars_update_own` — existed in an earlier draft
-- of this file; the drops stay so a database that ever applied that draft ends
-- up in this state rather than keeping them.

drop policy if exists avatars_read_public on storage.objects;
drop policy if exists avatars_update_own on storage.objects;
drop policy if exists avatars_select_own on storage.objects;
drop policy if exists avatars_insert_own on storage.objects;
drop policy if exists avatars_delete_own on storage.objects;

-- SELECT, own folder only.
--
-- This exists because **Storage deletion requires it**: the service resolves an
-- object row before removing it, so a caller with DELETE but no SELECT cannot
-- delete their own avatar. It is not a read policy for rendering — rendering
-- goes through the public object endpoint, which never reads this table.
--
-- Scoped to the caller's own prefix so it cannot become an enumeration
-- primitive: listing `avatars/` returns your own objects and nothing else.
create policy avatars_select_own
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- `storage.foldername(name)` returns the path's directory segments; `[1]` is
-- the first. The comparison against `auth.uid()` is the whole ownership model.
create policy avatars_insert_own
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Deletion is how an old avatar is cleaned up after a replacement, and how a
-- player removes their photo.
create policy avatars_delete_own
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

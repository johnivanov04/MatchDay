-- MatchDay — the profile stops being owned by the Auth user.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
--
-- Apple requires an app that creates accounts to let somebody delete theirs
-- from inside the app. Deleting `auth.users` is what "deleted" means — but
-- `profiles.id` was a foreign key to it with ON DELETE CASCADE, and six tables
-- cascade from `profiles` in turn. Measured on a completed match with a
-- published team sheet, deleting the Auth user took the player out of the team
-- sheet, out of the attendance register, and out of the confirmed count:
--
--     with the player     team_sheet 1  attendance 1  signups 1  confirmed 1
--     after hard delete   team_sheet 0  attendance 0  signups 0  confirmed 0
--
-- A match that was played, whose teams were published and whose register was
-- completed, silently lost a player from all three. That is not a record of an
-- evening; it is a record with a hole in it and no marker that anything was
-- removed.
--
-- (It also could not happen at all: `audit_events.actor_user_id` is ON DELETE
-- SET NULL, a SET NULL is an UPDATE, and `audit_events_immutable` refuses every
-- UPDATE. So the delete aborted with AUDIT_EVENT_IMMUTABLE for anybody who had
-- ever performed an audited action — which is every real user.)
--
-- ── WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT ───────────────────────────
--
-- One constraint is dropped. Nothing else about identity moves:
--
--   * `profiles.id` remains the primary key and remains MatchDay's permanent
--     identity for a person;
--   * for every live account `profiles.id` still equals `auth.uid()`, which is
--     what 15 RLS policies, ~60 SECURITY DEFINER functions, the
--     `profiles_photo_path_shape` CHECK and all three `avatars` storage
--     policies already assume. A separate `auth_user_id` column would have
--     forced an indirection into every one of them and made the avatar folder
--     (`auth.uid()`) disagree with the path constraint (`id`);
--   * every other foreign key is untouched. Nothing is rewritten merely
--     because Auth is no longer the parent.
--
-- The one behaviour that genuinely changes: an `auth.users` row deleted
-- *outside* MatchDay — the Supabase dashboard, a support script — no longer
-- cascades, and leaves a profile with no way to sign in. That state is exactly
-- what the reconciler detects and finishes; see
-- `20260823100500_account_deletion.sql`.

alter table public.profiles drop constraint profiles_id_fkey;

comment on column public.profiles.id is
  'MatchDay''s permanent identity for a person, and the parent of every '
  'membership and history row. Equal to auth.uid() for every live account. No '
  'longer a foreign key to auth.users: a tombstone must outlive the Auth row '
  'so that completed matches keep their participants.';


-- ── The deletion lifecycle ─────────────────────────────────────────────────
--
-- TWO COLUMNS, NOT ONE, and the distinction is the whole reason the workflow is
-- safe. Deleting an account spans three systems that cannot share a
-- transaction — Postgres, Storage (which refuses SQL deletes outright) and
-- GoTrue — so there is a real, observable middle state, and a single flag would
-- have to lie about it in one direction or the other.
--
--   LIVE       started is null      deleted is null
--   PENDING    started is not null  deleted is null
--   TOMBSTONE  deleted is not null
--
-- `deletion_started_at` is set first and on its own. That is what makes the
-- avatar cleanup safe: from that instant `avatars_insert_own` refuses, so no
-- new object can appear between enumerating the folder and emptying it. Without
-- it, a user could upload a replacement while Storage cleanup was retrying and
-- the retry would delete a stale list.
--
-- `deleted_at` is set only once the personal-data scrub has committed. A row
-- carrying it makes a promise — this profile holds nothing personal — and
-- nothing may set it before that is true.
--
-- Neither means "the Auth row is gone". That is a fourth fact, living in
-- another system, and the reconciler is what closes it.

alter table public.profiles
  add column deletion_started_at timestamptz,
  add column deleted_at timestamptz;

comment on column public.profiles.deletion_started_at is
  'When the account holder began deleting their account. From this moment the '
  'profile can no longer participate in MatchDay — see is_live_profile().';
comment on column public.profiles.deleted_at is
  'When the personal-data scrub committed. Set only after the tombstone '
  'contract holds; never a synonym for "deletion requested".';

alter table public.profiles
  -- `deleted_at` implies `deletion_started_at`: a tombstone that was never
  -- started is a state no code path can produce and none should have to reason
  -- about.
  add constraint profiles_deletion_order check (
    deleted_at is null or deletion_started_at is not null
  );

-- Partial, because the interesting set is tiny and permanent: the accounts
-- whose cleanup has not finished. This is the reconciler's index and it stays
-- small forever.
create index profiles_deletion_incomplete_idx
  on public.profiles (deletion_started_at)
  where deletion_started_at is not null;


-- ── The deletion columns are not the client's to write ─────────────────────
--
-- `profiles_update_self` is `id = auth.uid()` with no column restriction, so
-- without this a signed-in user could set `deleted_at` on themselves from an
-- ordinary profile save — and, because the identity trigger below stands down
-- for a tombstone, could then rewrite their own email freely. That is a
-- privilege escalation dressed as a profile edit.
--
-- THE DISCRIMINATOR IS `current_user`, NOT `auth.uid()`. Inside a SECURITY
-- DEFINER function owned by `postgres` the session still carries the caller's
-- `auth.uid()` — the two are indistinguishable that way — but `current_user` is
-- `postgres` there and `authenticated` for a table write arriving through
-- PostgREST. Verified directly:
--
--     inside SECURITY DEFINER : postgres      / uid=1111…0003
--     direct as caller        : authenticated / uid=1111…0003
--
-- So the deletion machinery may write these columns and a client may not, with
-- no shared secret and no transaction-local flag to forget to set.
create or replace function public.profiles_guard_deletion_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.deletion_started_at is not null or new.deleted_at is not null then
      raise exception 'NOT_AUTHORIZED: deletion state is set by the deletion workflow'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.deletion_started_at is distinct from old.deletion_started_at
     or new.deleted_at is distinct from old.deleted_at then
    raise exception 'NOT_AUTHORIZED: deletion state is set by the deletion workflow'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger profiles_guard_deletion_state
  before insert or update on public.profiles
  for each row execute function public.profiles_guard_deletion_state();

revoke execute on function public.profiles_guard_deletion_state() from public;

comment on function public.profiles_guard_deletion_state() is
  'Refuses any client-originated write to deletion_started_at or deleted_at. '
  'Distinguishes the deletion machinery from a client by current_user, which '
  'is postgres inside a SECURITY DEFINER function and authenticated through '
  'PostgREST — auth.uid() is identical in both and cannot be used.';


-- ── The identity trigger stands down for a departing account ───────────────
--
-- THE TRAP THIS CLOSES. `profiles_sync_identity` forces `email_normalized` to
-- the JWT's email claim whenever `auth.uid() = new.id`. The deletion RPC runs
-- while the account holder is still signed in, so their real address is still
-- in the token — and a plain `update profiles set email_normalized = <synthetic>`
-- is silently overwritten with the real one. Every assertion about the *other*
-- scrubbed columns would still pass, and the single column that matters most
-- would quietly keep the address.
--
-- Amended, not removed: for a live profile the rule is unchanged and the email
-- is still owned by the verified session rather than by the client.
create or replace function public.profiles_sync_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_jwt_email text;
begin
  begin
    v_jwt_email := nullif(btrim(auth.jwt() ->> 'email'), '');
  exception
    when others then
      v_jwt_email := null;
  end;

  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.created_at := old.created_at;
  end if;

  -- A departing or departed account's address is no longer synchronised from
  -- the session. Ordering matters: this is checked on the *new* row, so the
  -- statement that starts the deletion is itself already exempt.
  if new.deletion_started_at is not null or new.deleted_at is not null then
    return new;
  end if;

  if v_actor is not null and v_actor = new.id then
    if v_jwt_email is not null then
      new.email_normalized := lower(v_jwt_email);
    elsif tg_op = 'UPDATE' then
      new.email_normalized := old.email_normalized;
    end if;
  end if;

  return new;
end;
$$;

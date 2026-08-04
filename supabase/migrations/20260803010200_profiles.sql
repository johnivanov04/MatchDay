-- Matchday — Phase 1
-- Global user profile. One row per authenticated account, reused across every
-- league membership (PRD §6 "Player profile", F-01).
--
-- Required: first name, last name, normalized email.
-- Optional: phone, gender, preferred positions, goalkeeper willingness, photo.
--
-- There is deliberately NO skill-level or skill-rating column, and none may be
-- added: PRD §5 lists automated skill ratings as an explicit non-goal and
-- F-07 forbids displaying or calculating one. tests/db/schema.test.ts fails the
-- build if any column matching '%skill%' ever appears.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,

  first_name text not null,
  last_name text not null,
  -- Server-derived from the verified session JWT, never from client input.
  email_normalized text not null,

  phone text,
  gender text,
  preferred_positions text[] not null default '{}'::text[],
  goalkeeper_willing boolean,
  profile_photo_url text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint profiles_first_name_length
    check (char_length(btrim(first_name)) between 1 and 80),
  constraint profiles_last_name_length
    check (char_length(btrim(last_name)) between 1 and 80),

  -- Lower-cased and trimmed at rest, so "Sam@Example.com" and "sam@example.com"
  -- collide on the unique index instead of creating a second account (F-01
  -- acceptance criterion: duplicate capitalization must not duplicate profiles).
  constraint profiles_email_normalized_format check (
    email_normalized = lower(btrim(email_normalized))
    and email_normalized ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    and char_length(email_normalized) <= 254
  ),

  constraint profiles_phone_length
    check (phone is null or char_length(btrim(phone)) between 3 and 32),

  -- The product documents never enumerate gender values, so none are invented
  -- here. Stored as constrained free text; see docs/decisions and TODO.md.
  constraint profiles_gender_length
    check (gender is null or char_length(btrim(gender)) between 1 and 64),

  constraint profiles_preferred_positions_valid check (
    array_length(preferred_positions, 1) is null
    or (
      array_ndims(preferred_positions) = 1
      and array_length(preferred_positions, 1) <= 8
      and array_position(preferred_positions, null::text) is null
      and public.text_array_entries_are_valid(preferred_positions, 1, 40)
    )
  ),

  constraint profiles_photo_url_scheme check (
    profile_photo_url is null
    or (profile_photo_url ~ '^https://' and char_length(profile_photo_url) <= 2048)
  )
);

create unique index profiles_email_normalized_key
  on public.profiles (email_normalized);

-- Identity columns are owned by the server, not the client. When a request
-- carries a verified Supabase session, the row's email is forced to the JWT's
-- email claim and `id`/`created_at` are pinned to their stored values. Without
-- a session (migrations, seed, service-role maintenance) the supplied values
-- are accepted, because that path is already privileged.
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

create trigger profiles_sync_identity
  before insert or update on public.profiles
  for each row execute function public.profiles_sync_identity();

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

comment on table public.profiles is
  'Global account profile shared across all league memberships. Contains no '
  'skill-level or skill-rating field by product decision (PRD §5, §6).';
comment on column public.profiles.email_normalized is
  'Lower-cased, trimmed email derived from the verified session JWT. Not client-trusted.';

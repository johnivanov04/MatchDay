-- Matchday — test harness only. NOT a migration; never applied to a real database.
--
-- Recreates the parts of a Supabase database that exist before the first
-- migration runs, so that `supabase/migrations/*.sql` and `supabase/seed.sql`
-- can be applied *verbatim* to a plain PostgreSQL server. Testing the real
-- migration files rather than a re-typed copy is the entire point: a policy
-- that only works in the test schema would be worthless.
--
-- Provided here:
--   * the anon / authenticated / service_role roles PostgREST switches into
--   * the auth schema, auth.users and auth.identities
--   * auth.uid(), auth.jwt() and auth.role(), reading the same
--     `request.jwt.claims` GUC that PostgREST sets from the verified JWT
--
-- Column lists for auth.users and auth.identities mirror GoTrue's schema. Only
-- the columns Matchday's seed and code touch need to be exact.

-- ── Roles ──────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;

  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;

  -- Matches hosted Supabase: the service role bypasses RLS entirely.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;

-- ── auth schema ────────────────────────────────────────────────────────────
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  instance_id uuid,
  id uuid primary key,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  confirmation_token varchar(255),
  confirmation_sent_at timestamptz,
  recovery_token varchar(255),
  recovery_sent_at timestamptz,
  email_change_token_new varchar(255),
  email_change varchar(255),
  email_change_sent_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_super_admin boolean,
  created_at timestamptz,
  updated_at timestamptz,
  phone text default null,
  phone_confirmed_at timestamptz,
  phone_change text default '',
  phone_change_token varchar(255) default '',
  phone_change_sent_at timestamptz,
  email_change_token_current varchar(255) default '',
  email_change_confirm_status smallint default 0,
  banned_until timestamptz,
  reauthentication_token varchar(255) default '',
  reauthentication_sent_at timestamptz,
  is_sso_user boolean not null default false,
  deleted_at timestamptz,
  is_anonymous boolean not null default false
);

create unique index if not exists users_email_partial_key
  on auth.users (email) where is_sso_user = false;

create table if not exists auth.identities (
  provider_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  identity_data jsonb not null,
  provider text not null,
  last_sign_in_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  email text generated always as (lower(identity_data ->> 'email')) stored,
  id uuid primary key default gen_random_uuid(),
  constraint identities_provider_id_provider_unique unique (provider_id, provider)
);

-- ── Session accessors ──────────────────────────────────────────────────────
-- PostgREST sets `request.jwt.claims` from the JWT it has already verified.
-- Nothing a client sends in a request body can influence these, which is what
-- makes RLS a real authorization boundary rather than a convention.

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
    ),
    ''
  );
$$;

grant execute on function auth.uid()  to anon, authenticated, service_role;
grant execute on function auth.jwt()  to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;

grant select on auth.users, auth.identities to service_role;

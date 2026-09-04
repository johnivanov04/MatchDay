-- MatchDay — Phase 3E: choosing what reaches you, and how.
--
-- ── WHAT THIS DOES NOT TOUCH ───────────────────────────────────────────────
--
-- The canonical in-app notification. Every business rule that decides a
-- notification exists is unchanged, every idempotency key is unchanged, and
-- nothing here can stop a row being written. A preference governs *delivery*,
-- not *record*: somebody who switches everything off still opens the app and
-- finds their match was cancelled.
--
-- That separation is why this is a small phase. Phases 3B–3D built one durable
-- job per notification and taught it two channels; 3E only decides, at the
-- moment of delivery, which of those channels is owed anything.
--
-- ── ABSENCE MEANS ENABLED ──────────────────────────────────────────────────
--
-- The single most important property. There is no backfill, no row created for
-- anybody, and the resolver treats a missing row as "yes".
--
-- So the instant this migration lands, every user's delivery behaviour is
-- byte-for-byte what Phase 3D did: push goes where push already went, and email
-- goes to exactly the accounts that had switched the global toggle on. The
-- Phase 3D application, still serving during the deploy window, does not know
-- this table exists and does not need to.
--
-- The alternative — defaulting to disabled and backfilling everyone to enabled —
-- would mean a migration that silently turns off notifications for anybody it
-- failed to reach, which is the kind of bug nobody notices until a player
-- misses a match.


-- ── The channel ────────────────────────────────────────────────────────────
--
-- Two values, deliberately. `in_app` is absent because in-app delivery is not
-- configurable and must not become configurable by someone adding an enum
-- value: the canonical record is the product's memory, not a notification
-- setting.
create type public.notification_channel as enum ('push', 'email');


create table public.notification_type_preferences (
  user_id uuid not null references public.profiles (id) on delete cascade,
  notification_type public.notification_type not null,
  channel public.notification_channel not null,

  -- Explicit, both ways. A row saying `true` and no row at all mean the same
  -- thing today; storing the `true` keeps the write path a single idempotent
  -- upsert rather than an insert-or-delete that has to decide which it is.
  enabled boolean not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- SPARSE. The key is what makes two browser tabs racing on the same toggle
  -- produce one row rather than two.
  primary key (user_id, notification_type, channel)
);

comment on table public.notification_type_preferences is
  'Sparse per-type external delivery overrides. ABSENCE MEANS ENABLED. '
  'Subordinate to notification_preferences.email_enabled for the email channel.';

create trigger notification_type_preferences_set_updated_at
  before update on public.notification_type_preferences
  for each row execute function public.set_updated_at();


-- Theirs alone, in the shape `notification_preferences` and `user_app_state`
-- already use — including the `is_live_profile()` gate on writes.
alter table public.notification_type_preferences enable row level security;
alter table public.notification_type_preferences force row level security;

create policy notification_type_preferences_select_self
  on public.notification_type_preferences for select to authenticated
  using (user_id = (select auth.uid()));

create policy notification_type_preferences_insert_self
  on public.notification_type_preferences for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_live_profile());

create policy notification_type_preferences_update_self
  on public.notification_type_preferences for update to authenticated
  using (user_id = (select auth.uid()) and public.is_live_profile())
  with check (user_id = (select auth.uid()) and public.is_live_profile());

revoke all on public.notification_type_preferences from public;
grant select, insert, update on public.notification_type_preferences to authenticated;
grant select, insert, update, delete on public.notification_type_preferences to service_role;


-- ── One resolver, both channels ────────────────────────────────────────────
--
-- Every rule that decides whether a channel is owed anything lives here, so
-- that provider code never asks a preference question and preference code never
-- asks a provider question.
--
-- A channel this returns "no" for is NOT A FAILURE. It is not owed. The worker
-- records no attempt, calls no provider, spends no Phase 3C retry budget, and
-- completes the job — because there is nothing to come back for.
--
-- PROVIDER AVAILABILITY IS DELIBERATELY NOT HERE. "Has this person got any
-- enabled devices" is a question the push dispatcher already answers by finding
-- none and attempting nothing. Mixing the two would make a preference lookup
-- depend on subscription state and vice versa.
create function public.notification_channel_eligibility(p_notification_id uuid)
returns table (
  push_allowed boolean,
  email_address text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_recipient uuid;
  v_type public.notification_type;
  v_email text;
begin
  -- Worker-only. This returns somebody's email address; a session must never
  -- be able to ask for it.
  if coalesce(auth.role(), 'service_role') <> 'service_role' then
    raise exception 'NOT_AUTHORIZED: delivery eligibility is a server-side operation'
      using errcode = '42501';
  end if;

  select n.recipient_user_id, n.type into v_recipient, v_type
  from public.notifications n
  where n.id = p_notification_id;

  if v_recipient is null then
    push_allowed := false;
    email_address := null;
    return next;
    return;
  end if;

  -- ── Push ────────────────────────────────────────────────────────────────
  --
  -- Absence means enabled, so this is "no row said no". There is no global push
  -- switch: a member who wants no push at all turns their devices off, which is
  -- a control that already exists and is per-device rather than per-account.
  push_allowed := not exists (
    select 1 from public.notification_type_preferences p
    where p.user_id = v_recipient
      and p.notification_type = v_type
      and p.channel = 'push'
      and not p.enabled
  );

  -- ── Email ───────────────────────────────────────────────────────────────
  --
  -- The Phase 3D global switch is the master and comes first: with it off, no
  -- per-type row can turn email back on. Turning it off does not erase those
  -- rows, so turning it on again restores exactly the choices the member made.
  if not exists (
    select 1 from public.notification_preferences g
    where g.user_id = v_recipient and g.email_enabled
  ) then
    email_address := null;
    return next;
    return;
  end if;

  if exists (
    select 1 from public.notification_type_preferences p
    where p.user_id = v_recipient
      and p.notification_type = v_type
      and p.channel = 'email'
      and not p.enabled
  ) then
    email_address := null;
    return next;
    return;
  end if;

  -- Somebody deleting their account is not owed more mail.
  if exists (
    select 1 from public.profiles p
    where p.id = v_recipient
      and (p.deletion_started_at is not null or p.deleted_at is not null)
  ) then
    email_address := null;
    return next;
    return;
  end if;

  -- Confirmed addresses only. An unverified address may belong to somebody
  -- else entirely, and league activity in a stranger's inbox is the failure
  -- this check exists to prevent.
  select u.email into v_email
  from auth.users u
  where u.id = v_recipient
    and u.email is not null
    and u.email_confirmed_at is not null;

  email_address := v_email;
  return next;
end;
$$;


-- ── The Phase 3D entry point, preserved ────────────────────────────────────
--
-- CREATE OR REPLACE with the signature untouched, because the Phase 3D worker
-- is still serving production when this migration lands and calls it by exactly
-- this shape. Changing the signature would have meant a DROP, a window with no
-- function, and PGRST202 in production.
--
-- It now delegates, so there is one place where email eligibility is decided
-- rather than two that can drift. With no override rows in existence — which is
-- the state this migration leaves behind — it returns precisely what it
-- returned before.
create or replace function public.notification_email_recipient(p_notification_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  if coalesce(auth.role(), 'service_role') <> 'service_role' then
    raise exception 'NOT_AUTHORIZED: recipient resolution is a server-side operation'
      using errcode = '42501';
  end if;

  select e.email_address into v_email
  from public.notification_channel_eligibility(p_notification_id) e;

  return v_email;
end;
$$;


-- ── Execution ──────────────────────────────────────────────────────────────
revoke execute on function public.notification_channel_eligibility(uuid) from public;
grant execute on function public.notification_channel_eligibility(uuid) to service_role;

revoke execute on function public.notification_email_recipient(uuid) from public;
grant execute on function public.notification_email_recipient(uuid) to service_role;


-- ── NO BACKFILL, AND NOTHING ELSE TOUCHED ──────────────────────────────────
--
-- This migration writes no preference row, no delivery job, no attempt row, and
-- rewrites no notification. It is schema and functions only. Every existing
-- user keeps exactly the delivery behaviour they had five minutes ago, and the
-- first row in this table will be written by somebody moving a toggle.

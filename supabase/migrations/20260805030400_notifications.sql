-- Matchday — Phase 3C
-- Canonical in-app notifications.
--
-- This table is the source of truth for every alert the product produces. Web
-- Push (Phase 3D) is a delivery channel layered on top of it: a push that fails,
-- or a user who never grants permission, loses no information, because the
-- record already exists here. Nothing in this migration knows that push exists.

create type public.notification_type as enum (
  -- Membership lifecycle (Phase 2 operations, wired up in 20260805030700).
  'join_request_submitted',
  'join_request_approved',
  'join_request_rejected',
  'league_invitation_accepted',
  -- Matches.
  'match_published',
  'match_changed',
  'match_canceled',
  -- Guidelines. Publishing emits exactly one of these: the "required" variant
  -- when acceptance is needed, the "published" variant when it is purely
  -- informational. Never both for one publication.
  'guideline_version_published',
  'guideline_acceptance_required'
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),

  recipient_user_id uuid not null references public.profiles (id) on delete cascade,
  league_id uuid not null references public.leagues (id) on delete cascade,
  match_id uuid,

  type public.notification_type not null,
  title text not null,
  body text not null,

  -- Same-origin path only. This is what a push notification click and an inbox
  -- row both navigate to, so it must never be able to carry a caller off-site.
  deep_link text not null,

  read_at timestamptz,
  archived_at timestamptz,

  -- Recipient-scoped, so a single global unique index is the whole idempotency
  -- guarantee: `<event>:<entity>:<revision?>:<recipient>`. Every writer inserts
  -- with ON CONFLICT DO NOTHING, which makes a retried domain operation a no-op
  -- rather than a second alert.
  idempotency_key text not null,

  -- Channel bookkeeping only — never a token, endpoint, key or provider
  -- response. Phase 3D writes `{"push_eligible": true}` and nothing else.
  delivery_metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),

  constraint notifications_title_length check (char_length(btrim(title)) between 1 and 160),
  constraint notifications_body_length check (char_length(btrim(body)) between 1 and 1000),

  -- Rejects absolute URLs, protocol-relative `//host` and backslash tricks.
  constraint notifications_deep_link_is_local
    check (deep_link ~ '^/[^/\\]' and char_length(deep_link) <= 512),

  constraint notifications_idempotency_key_length
    check (char_length(idempotency_key) between 8 and 240),
  constraint notifications_delivery_metadata_is_object
    check (jsonb_typeof(delivery_metadata) = 'object'),

  constraint notifications_match_fk
    foreign key (match_id, league_id)
    references public.matches (id, league_id) on delete cascade
);

create unique index notifications_idempotency_key_key
  on public.notifications (idempotency_key);

-- The inbox: one user's notifications, newest first.
create index notifications_recipient_created_idx
  on public.notifications (recipient_user_id, created_at desc);

-- The unread badge, which renders on every authenticated page. Partial, so the
-- index stays small as history accumulates.
create index notifications_unread_idx
  on public.notifications (recipient_user_id)
  where read_at is null and archived_at is null;

create index notifications_league_idx on public.notifications (league_id, created_at desc);

comment on table public.notifications is
  'Canonical notification records — the source of truth for every alert. Web '
  'Push delivers copies of these; it never replaces or bypasses them.';


-- ── Internal writer ────────────────────────────────────────────────────────
--
-- Deliberately unchecked, and therefore deliberately not callable by any client
-- role: it must be able to insert rows addressed to *other* users, which is
-- exactly what a domain fanout does and exactly what a client must never do.
-- EXECUTE is revoked from PUBLIC in 20260805030800; only the SECURITY DEFINER
-- domain functions, which run as the owner, can reach it.
create or replace function public.create_notification(
  p_recipient uuid,
  p_league_id uuid,
  p_type public.notification_type,
  p_title text,
  p_body text,
  p_deep_link text,
  p_idempotency_key text,
  p_match_id uuid default null,
  p_delivery_metadata jsonb default '{}'::jsonb
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications (
    recipient_user_id, league_id, match_id, type, title, body,
    deep_link, idempotency_key, delivery_metadata
  )
  values (
    p_recipient, p_league_id, p_match_id, p_type, p_title, p_body,
    p_deep_link, p_idempotency_key, coalesce(p_delivery_metadata, '{}'::jsonb)
  )
  on conflict (idempotency_key) do nothing
  returning id;
$$;


-- ── League fanout ──────────────────────────────────────────────────────────
--
-- One notification per active member. `p_exclude_user` is normally the acting
-- administrator: telling somebody what they themselves just did is noise, and
-- they are the one person guaranteed to already know.
--
-- Only `active` memberships are notified. Pending, suspended and removed
-- members are not eligible for member-only content, and a notification is a
-- pointer to member-only content.
create or replace function public.notify_league_members(
  p_league_id uuid,
  p_type public.notification_type,
  p_title text,
  p_body text,
  p_deep_link text,
  p_idempotency_prefix text,
  p_match_id uuid default null,
  p_exclude_user uuid default null,
  p_delivery_metadata jsonb default '{}'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created integer := 0;
  v_member record;
begin
  for v_member in
    select m.user_id
    from public.league_memberships m
    where m.league_id = p_league_id
      and m.status = 'active'
      and (p_exclude_user is null or m.user_id <> p_exclude_user)
  loop
    if public.create_notification(
         v_member.user_id, p_league_id, p_type, p_title, p_body, p_deep_link,
         p_idempotency_prefix || ':' || v_member.user_id::text,
         p_match_id, p_delivery_metadata
       ) is not null
    then
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$$;


-- ── Reading your own inbox ─────────────────────────────────────────────────
-- Mark-read is the only mutation Phase 3 exposes. The schema already carries
-- `archived_at` and a nullable `read_at`, so mark-unread and archive are
-- additions in a later phase rather than a migration.

create or replace function public.mark_notification_read(p_notification_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  -- Scoped by recipient, so naming another user's notification is simply a
  -- miss — indistinguishable from an identifier that does not exist.
  update public.notifications
     set read_at = coalesce(read_at, now())
   where id = p_notification_id
     and recipient_user_id = v_actor
  returning id into v_id;

  if v_id is null then
    raise exception 'NOTIFICATION_NOT_FOUND: no such notification'
      using errcode = 'P0001';
  end if;

  return v_id;
end;
$$;

create or replace function public.mark_all_notifications_read()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_count integer;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  with updated as (
    update public.notifications
       set read_at = now()
     where recipient_user_id = v_actor and read_at is null
    returning 1
  )
  select count(*) into v_count from updated;

  return v_count;
end;
$$;

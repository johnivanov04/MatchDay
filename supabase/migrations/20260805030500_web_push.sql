-- Matchday — Phase 3D
-- Web Push subscriptions and delivery bookkeeping.
--
-- A push subscription is a bearer credential. Anyone holding the endpoint plus
-- the p256dh and auth keys can display a notification on that device, from any
-- server, forever — until the user revokes it. So the three secret columns are
-- write-only from the application's point of view: a user creates them, and
-- nobody, including that same user, can ever read them back through the API.
-- Only the delivery worker, running server-side as the service role, sees them.

create type public.push_delivery_status as enum (
  'pending',
  'sent',
  -- Worth retrying: network blip, provider 5xx, rate limit.
  'temporary_failure',
  -- Never worth retrying with this payload: bad VAPID, payload too large.
  'permanent_failure',
  -- The subscription itself is dead (404/410). The row is kept for history;
  -- the subscription is disabled.
  'invalidated'
);


-- ── Subscriptions ──────────────────────────────────────────────────────────

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,

  -- The bearer credential. Never granted to any client role; see the
  -- column-level grant in 20260805030800.
  endpoint text not null,
  p256dh text not null,
  auth_secret text not null,

  -- User-facing label so somebody with three devices can tell them apart.
  device_label text,

  -- The single preference this phase supports. A full per-type preference
  -- matrix is deliberately out of scope; one switch per device is enough to
  -- honour "opt in" and "turn it off" without inventing a model that later
  -- product decisions would have to unpick.
  enabled boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_success_at timestamptz,
  -- Consecutive temporary failures; reset on success. Used to retire endpoints
  -- that are silently dead without waiting for an explicit 410.
  consecutive_failures integer not null default 0,
  disabled_reason text,

  constraint push_subscriptions_endpoint_shape
    check (endpoint ~ '^https://' and char_length(endpoint) between 20 and 2048),
  constraint push_subscriptions_p256dh_length check (char_length(p256dh) between 16 and 256),
  constraint push_subscriptions_auth_length check (char_length(auth_secret) between 8 and 256),
  constraint push_subscriptions_device_label_length
    check (device_label is null or char_length(btrim(device_label)) between 1 and 80),
  constraint push_subscriptions_consecutive_failures_non_negative
    check (consecutive_failures >= 0),
  constraint push_subscriptions_disabled_reason_length
    check (disabled_reason is null or char_length(btrim(disabled_reason)) between 1 and 120)
);

-- One row per endpoint globally. A browser re-subscribing produces the same
-- endpoint, so this is what turns "subscribe again" into an update rather than
-- a duplicate — including when a device changes hands between accounts.
create unique index push_subscriptions_endpoint_key
  on public.push_subscriptions (endpoint);

create index push_subscriptions_user_idx
  on public.push_subscriptions (user_id, created_at desc);

-- The delivery worker's lookup: enabled devices for a recipient.
create index push_subscriptions_user_enabled_idx
  on public.push_subscriptions (user_id)
  where enabled;

create trigger push_subscriptions_set_updated_at
  before update on public.push_subscriptions
  for each row execute function public.set_updated_at();

comment on table public.push_subscriptions is
  'Per-user, per-device Web Push subscriptions. endpoint/p256dh/auth_secret are '
  'bearer credentials and are never granted to any client role — a user can '
  'create and delete a subscription but can never read its keys back.';


-- ── Delivery attempts ──────────────────────────────────────────────────────
--
-- One row per (canonical notification, subscription). That pair is the unit of
-- idempotency: re-running the dispatcher for a notification cannot send the
-- same alert to the same device twice, however many times it is invoked.

create table public.push_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications (id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions (id) on delete cascade,

  status public.push_delivery_status not null default 'pending',
  attempt_count integer not null default 0,

  -- A category, never the provider's response. Raw responses can carry the
  -- endpoint, headers and tokens; none of that belongs in a queryable table.
  last_error_category text,

  last_attempted_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint push_delivery_attempts_attempt_count_non_negative check (attempt_count >= 0),
  constraint push_delivery_attempts_error_category_shape
    check (last_error_category is null or last_error_category ~ '^[a-z][a-z0-9_]{2,39}$'),
  constraint push_delivery_attempts_delivered_when_sent
    check ((status = 'sent') = (delivered_at is not null))
);

create unique index push_delivery_attempts_notification_subscription_key
  on public.push_delivery_attempts (notification_id, subscription_id);

create index push_delivery_attempts_status_idx
  on public.push_delivery_attempts (status, last_attempted_at);

create index push_delivery_attempts_subscription_idx
  on public.push_delivery_attempts (subscription_id, created_at desc);

create trigger push_delivery_attempts_set_updated_at
  before update on public.push_delivery_attempts
  for each row execute function public.set_updated_at();

comment on table public.push_delivery_attempts is
  'One row per (notification, subscription). Answers what was delivered, to '
  'which device, in what state, after how many attempts, and why it last '
  'failed — by category only, never by storing a provider response.';


-- ── Subscribe / unsubscribe ────────────────────────────────────────────────
--
-- Functions rather than an INSERT policy, because the caller must be able to
-- write columns it can never read. A policy would require SELECT to make the
-- upsert work; a SECURITY DEFINER function does not.

create or replace function public.register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_device_label text default null
)
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

  -- Re-subscribing the same browser yields the same endpoint. Taking ownership
  -- on conflict is correct and is also the only sane answer when a shared
  -- device moves between accounts: the endpoint belongs to whoever most
  -- recently granted permission on it, and the previous owner's copy must not
  -- linger and keep receiving their alerts.
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth_secret, device_label)
  values (
    v_actor, btrim(p_endpoint), btrim(p_p256dh), btrim(p_auth),
    nullif(btrim(coalesce(p_device_label, '')), '')
  )
  on conflict (endpoint) do update
    set user_id = v_actor,
        p256dh = excluded.p256dh,
        auth_secret = excluded.auth_secret,
        device_label = coalesce(excluded.device_label, public.push_subscriptions.device_label),
        enabled = true,
        disabled_reason = null,
        consecutive_failures = 0,
        last_seen_at = now()
  returning id into v_id;

  return v_id;
end;
$$;


create or replace function public.set_push_subscription_enabled(
  p_subscription_id uuid,
  p_enabled boolean
)
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

  update public.push_subscriptions
     set enabled = p_enabled,
         disabled_reason = case when p_enabled then null else 'user_disabled' end,
         consecutive_failures = case when p_enabled then 0 else consecutive_failures end
   where id = p_subscription_id
     and user_id = v_actor
  returning id into v_id;

  if v_id is null then
    raise exception 'NOT_AUTHORIZED: no such device' using errcode = '42501';
  end if;

  return v_id;
end;
$$;


create or replace function public.remove_push_subscription(p_subscription_id uuid)
returns void
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

  delete from public.push_subscriptions
   where id = p_subscription_id and user_id = v_actor
  returning id into v_id;

  -- Idempotent: removing a device twice, or a device that was already retired
  -- by the delivery worker, is a success rather than an error.
  if v_id is null then
    return;
  end if;
end;
$$;


-- ── Worker-side bookkeeping ────────────────────────────────────────────────
--
-- Called by the server-side dispatcher with the service role. Kept as functions
-- so the state machine lives next to the data instead of being reimplemented by
-- every caller.

create or replace function public.record_push_delivery_result(
  p_notification_id uuid,
  p_subscription_id uuid,
  p_status public.push_delivery_status,
  p_error_category text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.push_delivery_attempts (
    notification_id, subscription_id, status, attempt_count,
    last_error_category, last_attempted_at, delivered_at
  )
  values (
    p_notification_id, p_subscription_id, p_status, 1,
    p_error_category, now(),
    case when p_status = 'sent' then now() else null end
  )
  on conflict (notification_id, subscription_id) do update
    set status = excluded.status,
        attempt_count = public.push_delivery_attempts.attempt_count + 1,
        last_error_category = excluded.last_error_category,
        last_attempted_at = now(),
        delivered_at = case when excluded.status = 'sent'
                            then coalesce(public.push_delivery_attempts.delivered_at, now())
                            else null end;

  if p_status = 'sent' then
    update public.push_subscriptions
       set last_success_at = now(), consecutive_failures = 0, last_seen_at = now()
     where id = p_subscription_id;

  elsif p_status = 'invalidated' then
    -- The endpoint is gone. Retire the device rather than deleting it, so the
    -- user can see on their devices page why it stopped working.
    update public.push_subscriptions
       set enabled = false, disabled_reason = 'endpoint_gone'
     where id = p_subscription_id;

  elsif p_status = 'temporary_failure' then
    update public.push_subscriptions
       set consecutive_failures = consecutive_failures + 1
     where id = p_subscription_id;

    -- Silently dead endpoints never return 410; they just keep timing out.
    update public.push_subscriptions
       set enabled = false, disabled_reason = 'repeated_failures'
     where id = p_subscription_id and consecutive_failures >= 10;
  end if;
end;
$$;

-- MatchDay — Phase 3D: the second delivery channel.
--
-- ── ONE NOTIFICATION, TWO CHANNELS ─────────────────────────────────────────
--
-- No second notification row. The canonical notification is still the record;
-- email is another way of carrying it, exactly as push has been since Phase 3.
-- A notification therefore fans out to whichever channels its recipient has
-- configured, and the delivery job is finished when every applicable channel
-- has reached a terminal outcome.
--
-- ── NOBODY IS EMAILED BECAUSE WE SHIPPED THIS ──────────────────────────────
--
-- `email_enabled` defaults to FALSE and no row is created for anybody. Absence
-- means off, so there is no backfill, no migration that quietly signs up every
-- existing member, and nothing for the Phase 3C application to do differently
-- while it is still serving during the deploy window.
--
-- Turning it on affects notifications created afterwards. Enabling email does
-- not reach back for last week's matches: the delivery job for those has long
-- since reached a terminal state, and re-opening finished work to send a
-- fortnight of alerts is not a feature.


-- ── The preference ─────────────────────────────────────────────────────────
--
-- A table rather than a column on `user_app_state`, which is about which league
-- somebody is looking at. This one is about how they want to be contacted.
--
-- SHAPED FOR PHASE 3E. 3D owns the channel master switch and nothing else. When
-- per-type controls arrive they become their own table keyed on (user_id, type,
-- channel), and this row stays what it is: the switch that turns the whole
-- channel off regardless of any per-type refinement. Nothing here has to be
-- rewritten to get there.
create table public.notification_preferences (
  user_id uuid primary key references public.profiles (id) on delete cascade,

  -- Transactional MatchDay notifications only. There is no marketing email in
  -- this product and this flag must never come to mean one.
  email_enabled boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.notification_preferences is
  'Per-user delivery channel switches. Absence of a row means every optional '
  'channel is off. Phase 3E adds per-type refinement in its own table.';

create trigger notification_preferences_set_updated_at
  before update on public.notification_preferences
  for each row execute function public.set_updated_at();


-- Theirs, and only theirs. The same shape `user_app_state` uses, including the
-- `is_live_profile()` gate on writes: somebody midway through deleting their
-- account is not choosing to receive more email.
alter table public.notification_preferences enable row level security;
alter table public.notification_preferences force row level security;

create policy notification_preferences_select_self
  on public.notification_preferences for select to authenticated
  using (user_id = (select auth.uid()));

create policy notification_preferences_insert_self
  on public.notification_preferences for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_live_profile());

create policy notification_preferences_update_self
  on public.notification_preferences for update to authenticated
  using (user_id = (select auth.uid()) and public.is_live_profile())
  with check (user_id = (select auth.uid()) and public.is_live_profile());

revoke all on public.notification_preferences from public;
grant select, insert, update on public.notification_preferences to authenticated;
grant select, insert, update, delete on public.notification_preferences to service_role;


-- ── Email delivery state ───────────────────────────────────────────────────
--
-- Its own enum rather than reusing `push_delivery_status`. That one carries
-- `invalidated`, which means "retire this subscription" — a device concept with
-- no email analogue. Sharing the type would make an impossible state writable.
create type public.email_delivery_status as enum (
  'pending',
  'sent',
  'temporary_failure',
  'permanent_failure'
);


-- One row per notification. A notification has exactly one intended account
-- address, so the unique constraint is the whole idempotency story on this
-- side — the same role `push_delivery_attempts`'s (notification, subscription)
-- index plays for devices.
create table public.email_delivery_attempts (
  id uuid primary key default gen_random_uuid(),

  notification_id uuid not null unique
    references public.notifications (id) on delete cascade,

  status public.email_delivery_status not null default 'pending',

  -- Real provider requests only. A pass that decided email was a no-op, or
  -- skipped an address it had already delivered to, does not touch this.
  attempt_count integer not null default 0,

  last_error_category text,
  provider_message_id text,

  -- ── WHAT WE ALREADY ASKED RESEND TO SEND ─────────────────────────────────
  --
  -- SHA-256 of the canonicalised Resend request, recorded on the first real
  -- provider call and never overwritten.
  --
  -- Resend de-duplicates on (idempotency key AND identical payload). Send the
  -- same key with a different payload and it answers 409
  -- `invalid_idempotent_request`. Our key is derived from the notification id
  -- and is deliberately stable across retries — but the payload is not
  -- guaranteed to be: `to` is resolved from `auth.users` on every worker pass,
  -- and somebody can confirm a new address between the first attempt and the
  -- retry.
  --
  -- Minting a fresh key for the new address is the wrong fix: if the original
  -- request actually reached Resend and only our response was lost, a new key
  -- is a second email. So the fingerprint is compared instead, and a changed
  -- payload ends the channel rather than guessing.
  --
  -- A HASH, NOT THE CONTENT. This is 64 hex characters and reveals neither the
  -- address nor the message — the recipient is still never stored here.
  payload_fingerprint text,

  last_attempted_at timestamptz,
  sent_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ── NO RECIPIENT ADDRESS COLUMN, DELIBERATELY ────────────────────────────
  --
  -- Storing it would put a copy of somebody's email outside `auth.users`, where
  -- account deletion already knows how to scrub it, and would need its own
  -- erasure path to avoid outliving the account. Nothing needs it:
  -- `provider_message_id` is the handle Resend's own tooling answers to, and
  -- the recipient is always derivable from the notification. The address is
  -- resolved at send time and never persisted here.

  constraint email_delivery_attempts_attempt_count_non_negative
    check (attempt_count >= 0),

  -- A category, never a provider response body. Same rule and same regex as
  -- `push_delivery_attempts`.
  constraint email_delivery_attempts_error_category_shape
    check (last_error_category is null
           or last_error_category ~ '^[a-z][a-z0-9_]{2,39}$'),

  constraint email_delivery_attempts_provider_message_id_shape
    check (provider_message_id is null
           or provider_message_id ~ '^[A-Za-z0-9._:-]{1,128}$'),

  -- Exactly a SHA-256 in lowercase hex. The shape is the guarantee that
  -- nothing else — an address, a subject line — can be written into this
  -- column by a future caller that misunderstands it.
  constraint email_delivery_attempts_payload_fingerprint_shape
    check (payload_fingerprint is null or payload_fingerprint ~ '^[0-9a-f]{64}$'),

  constraint email_delivery_attempts_sent_when_sent
    check ((status = 'sent') = (sent_at is not null))
);

comment on table public.email_delivery_attempts is
  'One row per notification for the email channel. Service-role only; the '
  'recipient address is never stored here.';

create index email_delivery_attempts_status_idx
  on public.email_delivery_attempts (status);


-- Operational state, closed to every client role — the posture Phase 3B
-- established for `notification_delivery_jobs`. There is no member-facing view
-- of email plumbing in this phase and no grant that would allow one.
alter table public.email_delivery_attempts enable row level security;
alter table public.email_delivery_attempts force row level security;

revoke all on public.email_delivery_attempts from public;
revoke all on public.email_delivery_attempts from anon, authenticated;
grant select, insert, update, delete on public.email_delivery_attempts to service_role;


-- ── Who, if anyone, this notification should be emailed to ─────────────────
--
-- Every gate in one place, returning NULL when the answer is "nobody". The
-- worker treats NULL as a clean no-op: no attempt row, no provider call, no
-- retry work. An address that does not exist cannot be fixed by waiting.
--
-- READS auth.users, WHICH IS THE POINT. It is the only authoritative source of
-- both the address and whether it was ever confirmed; `profiles.email_normalized`
-- is a lowercased copy taken from a JWT and knows nothing about verification.
-- SECURITY DEFINER keeps that access here rather than spreading it.
create function public.notification_email_recipient(p_notification_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recipient uuid;
  v_email text;
begin
  -- Worker-only, following `generate_due_reminders` and the Phase 3B/3C queue
  -- functions. This returns somebody's email address; it is emphatically not
  -- something a session may call.
  if coalesce(auth.role(), 'service_role') <> 'service_role' then
    raise exception 'NOT_AUTHORIZED: recipient resolution is a server-side operation'
      using errcode = '42501';
  end if;

  select n.recipient_user_id into v_recipient
  from public.notifications n
  where n.id = p_notification_id;

  if v_recipient is null then
    return null;
  end if;

  -- The switch. No row means off, which is what makes shipping this phase
  -- email nobody.
  if not exists (
    select 1 from public.notification_preferences p
    where p.user_id = v_recipient and p.email_enabled
  ) then
    return null;
  end if;

  -- Somebody deleting their account is not owed more mail.
  if exists (
    select 1 from public.profiles p
    where p.id = v_recipient
      and (p.deletion_started_at is not null or p.deleted_at is not null)
  ) then
    return null;
  end if;

  -- Confirmed addresses only. An unverified address may belong to somebody
  -- else entirely, and sending league activity to it would be the product
  -- leaking one person's matches to another's inbox.
  select u.email into v_email
  from auth.users u
  where u.id = v_recipient
    and u.email is not null
    and u.email_confirmed_at is not null;

  return v_email;
end;
$$;


-- ── Recording what the provider said ───────────────────────────────────────
--
-- Mirrors `record_push_delivery_result`, including the two behaviours that
-- matter across a Phase 3C retry: `attempt_count` climbs by one per real
-- provider request, and a retry that returns no identifier does not erase one
-- an earlier attempt captured.
create function public.record_email_delivery_result(
  p_notification_id uuid,
  p_status public.email_delivery_status,
  p_error_category text default null,
  p_provider_message_id text default null,
  p_payload_fingerprint text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), 'service_role') <> 'service_role' then
    raise exception 'NOT_AUTHORIZED: delivery bookkeeping is a server-side operation'
      using errcode = '42501';
  end if;

  insert into public.email_delivery_attempts (
    notification_id, status, attempt_count, last_error_category,
    last_attempted_at, sent_at, provider_message_id, payload_fingerprint
  )
  values (
    p_notification_id, p_status, 1, p_error_category,
    now(),
    case when p_status = 'sent' then now() else null end,
    p_provider_message_id, p_payload_fingerprint
  )
  on conflict (notification_id) do update
    set status = excluded.status,
        attempt_count = public.email_delivery_attempts.attempt_count + 1,
        last_error_category = excluded.last_error_category,
        last_attempted_at = now(),
        sent_at = case when excluded.status = 'sent'
                       then coalesce(public.email_delivery_attempts.sent_at, now())
                       else null end,
        provider_message_id = coalesce(
          excluded.provider_message_id,
          public.email_delivery_attempts.provider_message_id
        ),
        -- THE EXISTING VALUE WINS, which is the opposite of the rule above.
        -- The fingerprint records what was sent to Resend under this
        -- idempotency key the FIRST time. Letting a later attempt overwrite it
        -- would erase the very thing the comparison depends on.
        payload_fingerprint = coalesce(
          public.email_delivery_attempts.payload_fingerprint,
          excluded.payload_fingerprint
        );
end;
$$;


-- ── Execution ──────────────────────────────────────────────────────────────
revoke execute on function public.notification_email_recipient(uuid) from public;
revoke execute on function public.record_email_delivery_result(
  uuid, public.email_delivery_status, text, text, text) from public;

grant execute on function public.notification_email_recipient(uuid) to service_role;
grant execute on function public.record_email_delivery_result(
  uuid, public.email_delivery_status, text, text, text) to service_role;

-- MatchDay — the identifier the push provider gave a delivery attempt.
--
-- ── WHY THIS COLUMN EXISTS ─────────────────────────────────────────────────
--
-- APNs returns an `apns-id` header on every response, success or failure. It is
-- the only handle Apple's support and its delivery-status tooling recognise: a
-- question of the form "you accepted this notification, what happened to it"
-- cannot be asked without one.
--
-- Build #2 shipped without capturing it. The first production send returned
-- HTTP 200 and was recorded as `sent`, which is the right answer to "did Apple
-- take it" and no answer at all to "which one". This closes that.
--
-- ── NAMED FOR THE PROBLEM, NOT FOR APPLE ───────────────────────────────────
--
-- `provider_message_id`, not `apns_id`. Web Push responses carry their own
-- message identifier, and the email channel this build is heading towards will
-- carry a third. One nullable column per attempt describes all of them, and
-- avoids a rename the moment a second provider needs the same treatment.
--
-- Nullable throughout, deliberately. A provider that returns nothing, a
-- transport error that never reached one, and every row written before this
-- migration are all legitimately absent.

alter table public.push_delivery_attempts
  add column provider_message_id text,

  -- Provider-supplied, so bounded and constrained on the way in. APNs sends a
  -- canonical UUID; the shape here is wide enough for another provider's
  -- opaque token and narrow enough that nothing with a newline, a quote or a
  -- control character can be stored and later rendered somewhere.
  add constraint push_delivery_attempts_provider_message_id_shape
    check (provider_message_id is null
           or provider_message_id ~ '^[A-Za-z0-9._:-]{1,128}$');

comment on column public.push_delivery_attempts.provider_message_id is
  'The push provider''s own identifier for this attempt — APNs `apns-id`, and '
  'whatever the equivalent is for other channels. Support and delivery-status '
  'enquiries need it; nothing in the product reads it.';


-- ── record_push_delivery_result gains a parameter ──────────────────────────
--
-- Dropped and recreated rather than replaced. Adding a defaulted parameter to
-- the existing function creates a *second* signature rather than replacing the
-- first, and a four-argument call would then be ambiguous between them —
-- PostgreSQL refuses it at runtime, which would take the whole dispatcher down.
--
-- Dropped by exact identity signature and never with CASCADE: nothing should
-- disappear as a side effect of this, and if something depended on it, silence
-- would be the wrong answer.
--
-- The body is unchanged apart from writing the new column. The state machine —
-- `sent` clears the failure counter, `invalidated` retires the subscription,
-- `temporary_failure` counts toward the disable threshold, `permanent_failure`
-- deliberately touches nothing — is exactly as it was.

drop function if exists public.record_push_delivery_result(
  uuid, uuid, public.push_delivery_status, text
);

create or replace function public.record_push_delivery_result(
  p_notification_id uuid,
  p_subscription_id uuid,
  p_status public.push_delivery_status,
  p_error_category text default null,
  p_provider_message_id text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.push_delivery_attempts (
    notification_id, subscription_id, status, attempt_count,
    last_error_category, last_attempted_at, delivered_at, provider_message_id
  )
  values (
    p_notification_id, p_subscription_id, p_status, 1,
    p_error_category, now(),
    case when p_status = 'sent' then now() else null end,
    p_provider_message_id
  )
  on conflict (notification_id, subscription_id) do update
    set status = excluded.status,
        attempt_count = public.push_delivery_attempts.attempt_count + 1,
        last_error_category = excluded.last_error_category,
        last_attempted_at = now(),
        delivered_at = case when excluded.status = 'sent'
                            then coalesce(public.push_delivery_attempts.delivered_at, now())
                            else null end,
        -- The newest identifier wins, but a retry that produced none must not
        -- erase the one from the attempt that did.
        provider_message_id = coalesce(
          excluded.provider_message_id,
          public.push_delivery_attempts.provider_message_id
        );

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


-- ── Privileges ─────────────────────────────────────────────────────────────
--
-- A recreated function comes back EXECUTE-able by PUBLIC. Restored to exactly
-- what the dropped signature held: `service_role` alone. The dispatcher is the
-- only caller, and it runs server-side with that role.

revoke execute on function public.record_push_delivery_result(
  uuid, uuid, public.push_delivery_status, text, text
) from public;

grant execute on function public.record_push_delivery_result(
  uuid, uuid, public.push_delivery_status, text, text
) to service_role;

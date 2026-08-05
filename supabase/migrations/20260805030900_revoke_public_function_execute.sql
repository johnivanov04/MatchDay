-- Matchday — Phase 3
-- Hardening: take EXECUTE back from PUBLIC on every Phase 3 function.
--
-- THE DEFECT
-- 20260803020600 revoked EXECUTE from PUBLIC on every function that existed at
-- the time, and then tried to make the posture stick for future ones:
--
--     alter default privileges in schema public revoke execute on functions from public;
--
-- That statement recorded nothing. `pg_default_acl` holds no row for
-- (postgres, public, function), so every function created afterwards — which
-- is to say every function in Phase 3 — was created with the built-in default
-- of EXECUTE to PUBLIC. The Phase 2 comment claiming new functions "start with
-- no privileges" was therefore wrong, and was believed while writing Phase 3.
--
-- WHY IT MATTERS
-- Most of the affected functions authorize their own caller from `auth.uid()`,
-- so a stray grant changed nothing for them. `record_push_delivery_result()`
-- is the exception and the reason this is a security fix rather than tidying:
-- it takes a subscription id and a status, performs no authorization of its
-- own because only the delivery worker was ever meant to reach it, and on
-- `invalidated` it sets `enabled = false` on that subscription. Callable by
-- PUBLIC, it let any caller silently switch off another person's phone
-- notifications and forge delivery history.
--
-- THE FIX, IN TWO INDEPENDENT LAYERS
--   1. Revoke EXECUTE from PUBLIC across the schema. Role-specific grants
--      (`authenticated`, `service_role`) are separate ACL entries and survive.
--   2. Give the worker function an explicit actor check, so a future grant
--      mistake cannot resurrect the same hole.
--
-- `tests/db/schema.test.ts` now asserts that no function in `public` grants
-- EXECUTE to PUBLIC, which is the check that would have caught this.

revoke execute on all functions in schema public from public;

-- Re-stated by name so the intent is legible, and so a reader does not have to
-- reason about which grants survived the blanket revoke above.
grant execute on function public.current_required_guideline_version(uuid)   to authenticated, service_role;
grant execute on function public.has_accepted_required_guidelines(uuid)     to authenticated, service_role;
grant execute on function public.accept_guideline_version(uuid)             to authenticated, service_role;
grant execute on function public.publish_guideline_version(uuid)            to authenticated, service_role;
grant execute on function public.archive_guideline_version(uuid)            to authenticated, service_role;
grant execute on function public.league_guideline_acceptance_status(uuid)   to authenticated, service_role;
grant execute on function public.publish_match(uuid)                        to authenticated, service_role;
grant execute on function public.cancel_match(uuid, text)                   to authenticated, service_role;
grant execute on function public.mark_notification_read(uuid)               to authenticated, service_role;
grant execute on function public.mark_all_notifications_read()              to authenticated, service_role;
grant execute on function public.register_push_subscription(text, text, text, text)
  to authenticated, service_role;
grant execute on function public.set_push_subscription_enabled(uuid, boolean)
  to authenticated, service_role;
grant execute on function public.remove_push_subscription(uuid)             to authenticated, service_role;
grant execute on function public.owns_membership(uuid)                      to authenticated, service_role;
grant execute on function public.owns_push_subscription(uuid)               to authenticated, service_role;

grant execute on function public.create_match(
  uuid, text, date, time, time, time, text, integer, integer,
  public.selection_mode, public.waitlist_mode, integer, uuid, text,
  interval, interval, interval, interval, text, text
) to authenticated, service_role;

grant execute on function public.update_published_match(
  uuid, text, date, time, time, time, text, integer, integer, integer, text, text, text
) to authenticated, service_role;

grant execute on function public.record_push_delivery_result(
  uuid, uuid, public.push_delivery_status, text
) to service_role;


-- ── Layer two: the worker function validates its own caller ────────────────
--
-- `auth.role()` reads the verified JWT's role claim. A user session presents
-- `authenticated`, an anonymous one `anon`, the delivery worker's service-role
-- key presents `service_role`, and a direct server-side connection presents no
-- JWT at all. Only the last two may record a delivery result.
--
-- This is deliberate duplication of the grant above. The grant is the control;
-- this is what makes a mistake in the grant survivable.
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
  if coalesce(auth.role(), 'service_role') <> 'service_role' then
    raise exception 'NOT_AUTHORIZED: delivery results are recorded by the delivery worker only'
      using errcode = '42501';
  end if;

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
    update public.push_subscriptions
       set enabled = false, disabled_reason = 'endpoint_gone'
     where id = p_subscription_id;

  elsif p_status = 'temporary_failure' then
    update public.push_subscriptions
       set consecutive_failures = consecutive_failures + 1
     where id = p_subscription_id;

    update public.push_subscriptions
       set enabled = false, disabled_reason = 'repeated_failures'
     where id = p_subscription_id and consecutive_failures >= 10;
  end if;
end;
$$;

-- `create or replace` above resets the ACL, so the grant has to be restated.
revoke execute on function public.record_push_delivery_result(
  uuid, uuid, public.push_delivery_status, text
) from public;
grant execute on function public.record_push_delivery_result(
  uuid, uuid, public.push_delivery_status, text
) to service_role;

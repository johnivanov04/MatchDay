-- Matchday — Phase 2
-- Automatic audit events for league and membership changes.
--
-- WHY TRIGGERS RATHER THAN CALLS IN THE SERVER ACTIONS:
-- Phase 1 already grants administrators a direct UPDATE policy on `leagues` and
-- `league_memberships`. That policy is correct and is left untouched — but it
-- means a settings change can arrive straight from PostgREST without passing
-- through any application code. If the audit event were written by the server
-- action, that path would be silently unaudited, and F-02's "Changing
-- visibility creates an audit event" would hold only for well-behaved clients.
--
-- A trigger sits below every path: server action, direct API call, psql, or a
-- future migration. There is no way to change these rows without the change
-- being recorded.
--
-- Events are written only when `auth.uid()` is present, i.e. when a real
-- authenticated actor made the change. Seeding and service-role bulk loads
-- carry no session and are not administrator actions, so they produce no audit
-- rows — which also keeps `supabase/seed.sql` reproducible and the Phase 1
-- audit assertions intact.

-- Returns only the keys whose value differs between two JSONB objects,
-- projected from whichever side the caller asks for. Keeps the audit log to the
-- fields that actually moved instead of a full row copy.
create or replace function public.jsonb_changed_keys(
  p_before jsonb,
  p_after jsonb,
  p_side text
)
returns jsonb
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    jsonb_object_agg(
      k,
      case when p_side = 'before' then p_before -> k else p_after -> k end
    ),
    '{}'::jsonb
  )
  from jsonb_object_keys(p_after) as k
  where p_before -> k is distinct from p_after -> k;
$$;


-- ── leagues ────────────────────────────────────────────────────────────────
create or replace function public.leagues_audit_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_before jsonb;
  v_after jsonb;
  v_action text;
begin
  if v_actor is null then
    return null;
  end if;

  v_before := public.jsonb_changed_keys(
    to_jsonb(old) - 'updated_at', to_jsonb(new) - 'updated_at', 'before');
  v_after := public.jsonb_changed_keys(
    to_jsonb(old) - 'updated_at', to_jsonb(new) - 'updated_at', 'after');

  -- A no-op update is not an event.
  if v_after = '{}'::jsonb then
    return null;
  end if;

  -- Visibility is called out separately because F-02 makes it an explicit
  -- acceptance criterion, and because it is the one setting that changes who
  -- outside the league can see it at all.
  v_action := case
                when old.visibility is distinct from new.visibility
                then 'league.visibility_changed'
                else 'league.updated'
              end;

  perform public.log_audit_event(
    new.id, v_actor, 'league', new.id, v_action, v_before, v_after, null);

  return null;
end;
$$;

create trigger leagues_audit_update
  after update on public.leagues
  for each row execute function public.leagues_audit_update();


-- ── league_memberships ─────────────────────────────────────────────────────
create or replace function public.league_memberships_audit_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_action text;
  v_before jsonb;
  v_after jsonb;
begin
  if v_actor is null then
    return null;
  end if;

  if tg_op = 'INSERT' then
    v_action := 'membership.created';
    v_before := null;
    v_after := jsonb_build_object('role', new.role, 'status', new.status);
  else
    if new.role is distinct from old.role then
      v_action := 'membership.role_changed';
    elsif new.status is distinct from old.status then
      v_action := 'membership.status_changed';
    else
      return null;
    end if;

    v_before := jsonb_build_object('role', old.role, 'status', old.status);
    v_after := jsonb_build_object('role', new.role, 'status', new.status);
  end if;

  perform public.log_audit_event(
    new.league_id, v_actor, 'league_membership', new.id, v_action,
    v_before, v_after, null);

  return null;
end;
$$;

create trigger league_memberships_audit_change
  after insert or update on public.league_memberships
  for each row execute function public.league_memberships_audit_change();

comment on function public.leagues_audit_update() is
  'Records league.updated / league.visibility_changed for any authenticated '
  'change, whichever code path made it.';
comment on function public.league_memberships_audit_change() is
  'Records membership.created / role_changed / status_changed for any '
  'authenticated change, whichever code path made it.';

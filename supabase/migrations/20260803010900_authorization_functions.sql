-- Matchday — Phase 1
-- Authorization primitives shared by every RLS policy.
--
-- These are SECURITY DEFINER for a specific, necessary reason: a policy on
-- `league_memberships` that queries `league_memberships` would recurse forever
-- under RLS. Running the lookup as the function owner breaks the cycle.
--
-- Safety properties of that choice:
--   * every function pins `search_path = ''`, so nothing on the caller's path
--     can be substituted for a referenced object;
--   * every function answers only about `auth.uid()` — the *caller's own*
--     relationship to a league — and returns a boolean, so no row from another
--     tenant can escape through the return value;
--   * EXECUTE is granted narrowly in 20260803011100_grants.sql.
--
-- `auth.uid()` reads the verified JWT that PostgREST attached to the
-- connection. It cannot be supplied or overridden by request parameters, which
-- is what makes "never trust a client-supplied user ID" true at the database
-- layer and not only in application code.

-- Any relationship with the league short of having been removed.
create or replace function public.is_league_member(p_league_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.league_memberships m
    where m.league_id = p_league_id
      and m.user_id = auth.uid()
      and m.status <> 'removed'
  );
$$;

-- Full member: the status that grants member-only league content.
create or replace function public.is_active_member(p_league_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.league_memberships m
    where m.league_id = p_league_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

-- The single active administrator of this league.
create or replace function public.is_league_admin(p_league_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.league_memberships m
    where m.league_id = p_league_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role = 'league_admin'
  );
$$;

-- True when the caller administers at least one league that p_user_id belongs
-- to. Backs the "administrators may read profiles of their own members" policy
-- (02 §20) without granting members visibility of each other's private fields.
create or replace function public.administers_league_of_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.league_memberships target
    join public.league_memberships administrator
      on administrator.league_id = target.league_id
    where target.user_id = p_user_id
      and target.status <> 'removed'
      and administrator.user_id = auth.uid()
      and administrator.status = 'active'
      and administrator.role = 'league_admin'
  );
$$;

-- Sole write path into the audit log for a user session.
--
-- The actor is taken from the session, never from a parameter, and the caller
-- must be the league's active administrator. `authenticated` has no INSERT
-- privilege on audit_events, so this function (or a service-role connection)
-- is the only way an event can be created.
create or replace function public.record_audit_event(
  p_league_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_action text,
  p_before jsonb default null,
  p_after jsonb default null,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_event_id uuid;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session'
      using errcode = '42501';
  end if;

  if not public.is_league_admin(p_league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the active administrator of league %', p_league_id
      using errcode = '42501';
  end if;

  insert into public.audit_events (
    league_id, actor_user_id, entity_type, entity_id, action,
    before_data, after_data, reason
  )
  values (
    p_league_id, v_actor, p_entity_type, p_entity_id, p_action,
    p_before, p_after, p_reason
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

comment on function public.record_audit_event(uuid, text, uuid, text, jsonb, jsonb, text) is
  'Records an administrator audit event. Actor is derived from auth.uid(); '
  'raises NOT_LEAGUE_ADMIN unless the caller actively administers p_league_id.';

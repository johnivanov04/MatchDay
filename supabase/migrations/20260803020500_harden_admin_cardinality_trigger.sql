-- Matchday — Phase 2
-- Hardening: make the single-administrator constraint independent of the
-- caller's Row Level Security.
--
-- THE DEFECT
-- `enforce_single_active_league_admin()` was created in Phase 1 without
-- SECURITY DEFINER, so its body executes with the privileges of whoever
-- triggered it. It opens with a guard meaning "skip if the league was deleted
-- later in this transaction":
--
--     if exists (select 1 from public.leagues l where l.id = v_league_id) then
--
-- Under RLS that question is not "does this league exist?" but "can the caller
-- see this league?". `leagues_select_member` answers via `is_league_member()`,
-- which is false for a removed membership. So when an administrator sets their
-- OWN membership to 'removed', the league becomes invisible to them, the guard
-- concludes it was deleted, and the cardinality check is skipped entirely —
-- committing a league with zero active administrators.
--
-- Phase 1 never reached this: it had no code path where a user changed their
-- own membership. Phase 2's member-management screen does, which is how it
-- surfaced. It also behaved differently across engines (PostgreSQL 17 rejected
-- the commit, PostgreSQL 18 allowed it), which is itself a reason not to leave
-- an invariant depending on evaluation context.
--
-- THE FIX
-- SECURITY DEFINER, exactly as `user_app_state_validate_active_league()` and
-- the authorization helpers already are. An integrity rule must give the same
-- verdict no matter who triggered it; "can the actor see this row?" is an
-- authorization question and has no business inside one.
--
-- This strictly tightens the invariant. No policy is changed, and nothing that
-- was previously rejected is now allowed.

create or replace function public.enforce_single_active_league_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_league_ids uuid[];
  v_league_id uuid;
  v_admin_count integer;
begin
  if tg_table_name = 'leagues' then
    v_league_ids := array[new.id];
  elsif tg_op = 'DELETE' then
    v_league_ids := array[old.league_id];
  elsif tg_op = 'INSERT' then
    v_league_ids := array[new.league_id];
  else
    -- league_id is immutable (league_memberships_guard_immutable_columns), but
    -- checking both sides keeps this correct if that guard is ever relaxed.
    v_league_ids := array[new.league_id, old.league_id];
  end if;

  foreach v_league_id in array v_league_ids loop
    -- Genuinely "was this league deleted in the same transaction?", now that
    -- the lookup is no longer filtered by the caller's visibility.
    if exists (select 1 from public.leagues l where l.id = v_league_id) then
      select count(*)
        into v_admin_count
        from public.league_memberships m
       where m.league_id = v_league_id
         and m.role = 'league_admin'
         and m.status = 'active';

      if v_admin_count <> 1 then
        raise exception
          'LEAGUE_ADMIN_CARDINALITY: league % must have exactly one active league_admin, found %',
          v_league_id, v_admin_count
          using errcode = '23514';
      end if;
    end if;
  end loop;

  return null;
end;
$$;

comment on function public.enforce_single_active_league_admin() is
  'Deferred constraint trigger asserting each league commits with exactly one '
  'active league_admin. SECURITY DEFINER so the check cannot be skipped by a '
  'caller whose own RLS hides the league — see 20260803020500.';

-- Matchday — Phase 1
-- Exactly one active league administrator per league, part 2 of 2.
--
-- Part 1 (20260803010400) is the partial unique index that makes a *second*
-- active league_admin impossible. That alone permits *zero*, which F-02 forbids:
--   "A league cannot have zero or two active administrators after a successful
--    transaction."
--
-- The word "transaction" is the whole design. A DEFERRABLE INITIALLY DEFERRED
-- constraint trigger runs at COMMIT, not per statement, so:
--   * a league may be inserted before its administrator membership exists,
--     provided both land in the same transaction;
--   * a Phase 2 ownership transfer may demote then promote inside one
--     transaction and pass, because only the end state is inspected;
--   * committing a league with no active administrator, or removing/suspending
--     the last one, fails at COMMIT and rolls the whole transaction back.
--
-- This runs below every API, server action and RLS policy: no code path,
-- including the service-role key, can commit a league without exactly one
-- active administrator.

create or replace function public.enforce_single_active_league_admin()
returns trigger
language plpgsql
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
    -- The league itself may have been deleted later in the same transaction;
    -- a cardinality rule about a league that no longer exists is vacuous.
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

create constraint trigger leagues_require_single_active_admin
  after insert on public.leagues
  deferrable initially deferred
  for each row execute function public.enforce_single_active_league_admin();

create constraint trigger league_memberships_require_single_active_admin
  after insert or update or delete on public.league_memberships
  deferrable initially deferred
  for each row execute function public.enforce_single_active_league_admin();

comment on function public.enforce_single_active_league_admin() is
  'Deferred constraint trigger asserting each league commits with exactly one '
  'active league_admin. Pairs with league_memberships_single_active_admin_key.';

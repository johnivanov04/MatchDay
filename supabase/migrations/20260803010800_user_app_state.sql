-- Matchday — Phase 1
-- Per-user application state: which league the user is currently looking at.
--
-- PRD §11 requires the league switcher to preserve the selected league
-- "between sessions", so the selection is stored server-side rather than in a
-- cookie or localStorage. A cookie would also be client-controlled, and the
-- active league scopes what the user sees.
--
-- Note that this table is *convenience*, not authorization: no RLS policy
-- anywhere consults `active_league_id`. Access is always decided from
-- league_memberships. A tampered active league can therefore reveal nothing.

create table public.user_app_state (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  active_league_id uuid references public.leagues (id) on delete set null,
  updated_at timestamptz not null default now()
);

create index user_app_state_active_league_idx
  on public.user_app_state (active_league_id);

-- A user may only select a league where they hold an *active* membership.
-- Pending, suspended and removed memberships appear in the switcher but cannot
-- become the working context. Enforced in the database so that a forged
-- server-action payload cannot set a league the user does not belong to.
--
-- SECURITY DEFINER so the membership lookup is not itself filtered by the
-- caller's RLS: otherwise this integrity rule would give a different verdict
-- depending on who asked, and a legitimate write could be rejected as if the
-- membership did not exist.
--
-- The actor check comes first, and on purpose. BEFORE triggers run ahead of
-- the RLS WITH CHECK, so without it an attacker could insert rows naming
-- another user and read the membership answer out of the resulting error —
-- turning this trigger into a cross-tenant "is X a member of league Y?" oracle.
-- Failing on the actor first makes both outcomes indistinguishable.
create or replace function public.user_app_state_validate_active_league()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and new.user_id <> auth.uid() then
    raise exception 'NOT_AUTHORIZED: cannot write application state for another user'
      using errcode = '42501';
  end if;

  if new.active_league_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from public.league_memberships m
    where m.league_id = new.active_league_id
      and m.user_id = new.user_id
      and m.status = 'active'
  ) then
    raise exception
      'MEMBERSHIP_REQUIRED: user % has no active membership in league %',
      new.user_id, new.active_league_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger user_app_state_validate_active_league
  before insert or update on public.user_app_state
  for each row execute function public.user_app_state_validate_active_league();

create trigger user_app_state_set_updated_at
  before update on public.user_app_state
  for each row execute function public.set_updated_at();

comment on table public.user_app_state is
  'Server-persisted active-league selection. Convenience state only — never '
  'consulted for authorization.';

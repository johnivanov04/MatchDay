-- Matchday — Phase 1
-- League memberships: the join that makes tenancy work. One user may hold many
-- memberships (one per league); a league may have many members.
--
-- Roles: league_admin | player.  Statuses: pending | active | suspended | removed.
-- Rows are never hard-deleted in normal operation — status moves to 'removed'
-- so history survives (02 §19 "Historical records are archived, not silently
-- deleted"). Accordingly there is no DELETE policy for `authenticated`.

create table public.league_memberships (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,

  role public.league_role not null default 'player',
  status public.membership_status not null default 'pending',

  suspended_until timestamptz,
  joined_at timestamptz,
  status_changed_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A suspension end date is meaningless unless the member is suspended.
  constraint league_memberships_suspended_until_requires_suspended
    check (suspended_until is null or status = 'suspended'),

  -- Someone who has never left 'pending' has not joined anything yet.
  constraint league_memberships_joined_at_requires_membership
    check (joined_at is null or status <> 'pending')
);

-- One membership per user per league (02 §19).
create unique index league_memberships_league_user_key
  on public.league_memberships (league_id, user_id);

-- ── Exactly one active administrator, part 1 of 2 ──────────────────────────
-- "At most one": a partial unique index makes a second active league_admin row
-- physically unrepresentable. Deliberately NOT deferrable, so a Phase 2
-- ownership transfer must demote the outgoing administrator before promoting
-- the incoming one inside the same transaction.
-- Part 2 ("at least one") is the deferred constraint trigger in
-- 20260803010500_single_active_admin.sql.
create unique index league_memberships_single_active_admin_key
  on public.league_memberships (league_id)
  where role = 'league_admin'::public.league_role
    and status = 'active'::public.membership_status;

-- Composite key so tenant-owned children can carry a (membership_id, league_id)
-- foreign key and therefore cannot be pointed at another league's membership.
alter table public.league_memberships
  add constraint league_memberships_id_league_key unique (id, league_id);

-- "Which leagues am I in?" — league switcher, active-league resolution.
create index league_memberships_user_status_idx
  on public.league_memberships (user_id, status);

-- "Who is in this league?" — member management, future roster queries.
create index league_memberships_league_status_idx
  on public.league_memberships (league_id, status);

-- "Who administers this league?" — authorization checks on every admin action.
create index league_memberships_league_role_active_idx
  on public.league_memberships (league_id, role)
  where status = 'active'::public.membership_status;

-- A membership may change role or status, but it may never be re-pointed at a
-- different league or a different person. Without this, a league administrator
-- holding UPDATE rights could rewrite `user_id` and impersonate a membership.
create or replace function public.league_memberships_guard_immutable_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.league_id is distinct from old.league_id then
    raise exception 'MEMBERSHIP_LEAGUE_IMMUTABLE: league_id cannot be changed'
      using errcode = '23514';
  end if;

  if new.user_id is distinct from old.user_id then
    raise exception 'MEMBERSHIP_USER_IMMUTABLE: user_id cannot be changed'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- Keeps status bookkeeping honest regardless of which client wrote the row.
create or replace function public.league_memberships_track_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;

  if new.status <> 'pending' and new.joined_at is null then
    new.joined_at := now();
  end if;

  -- Reinstating a suspended member clears their suspension end date. Note the
  -- deliberately narrow condition: only a status *transition* away from
  -- 'suspended' clears it. Setting `suspended_until` on a membership that is
  -- not suspended is left to fail against
  -- league_memberships_suspended_until_requires_suspended, rather than being
  -- silently discarded here.
  if tg_op = 'UPDATE' and old.status = 'suspended' and new.status <> 'suspended' then
    new.suspended_until := null;
  end if;

  return new;
end;
$$;

create trigger league_memberships_guard_immutable_columns
  before update on public.league_memberships
  for each row execute function public.league_memberships_guard_immutable_columns();

create trigger league_memberships_track_status
  before insert or update on public.league_memberships
  for each row execute function public.league_memberships_track_status();

create trigger league_memberships_set_updated_at
  before update on public.league_memberships
  for each row execute function public.set_updated_at();

comment on table public.league_memberships is
  'Tenancy join table. Exactly one active league_admin per league is enforced '
  'by league_memberships_single_active_admin_key (at most one) and the deferred '
  'constraint trigger enforce_single_active_league_admin (at least one).';

-- Matchday — Phase 7, found by the concurrency suite
-- Ordering a suspension against a signup that has not happened yet.
--
-- THE RACE. `set_membership_status()` cascades by scanning the member's future
-- matches and locking each one. That orders it against every signup change on a
-- match the member is *already* in — but a match they are about to join is not
-- in the scan, so no lock is taken on it and the two transactions touch
-- completely disjoint rows:
--
--   T1  update league_memberships -> suspended
--   T1  scan future matches for this member ............ finds nothing
--   T2  lock match M, read membership (still active in T2's snapshot)
--   T1  COMMIT
--   T2  insert signup 'confirmed', COMMIT
--
-- leaving a suspended member holding a place in a match, which every later
-- stage — capacity, promotion, teams, attendance — then treats as real.
--
-- THE FIX is a lock the two transactions actually share: the membership row.
-- `set_membership_status()` takes it FOR UPDATE, and a signup that creates a new
-- place takes it FOR SHARE, so whichever arrives second sees the other's work
-- instead of a stale snapshot.
--
-- WHY ONLY ON INSERT, AND ONLY FOR A NEW ROW. A signup that already exists is
-- already covered: the cascade's scan finds it and locks its match, so the two
-- are ordered by the match row lock they both take. Taking the membership lock
-- there as well would invert the lock order — one transaction holding the match
-- and wanting the membership, the other holding the membership and wanting the
-- match — and deadlock. Restricted to genuinely new rows, the cycle cannot
-- form: a row the cascade has never seen is on a match the cascade never locks.
--
-- `insert ... on conflict do update` is why the existence test is explicit
-- rather than implied by the trigger event: a rejoin fires BEFORE INSERT even
-- though the row is there.

create or replace function public.match_signups_guard_membership_active()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status public.membership_status;
begin
  -- Only a row that holds a place. `unavailable`, `not_selected`, `canceled`
  -- and `withdrawn_late` take nothing from the match, so a suspended member
  -- carrying one is harmless — and the cascade itself writes `not_selected`.
  if not (public.signup_consumes_capacity(new.status) or new.status = 'waitlisted') then
    return new;
  end if;

  if exists (
    select 1 from public.match_signups s
    where s.match_id = new.match_id and s.membership_id = new.membership_id
  ) then
    return new;
  end if;

  -- FOR SHARE conflicts with the FOR NO KEY UPDATE that set_membership_status()
  -- holds, which is the point, and not with the FOR KEY SHARE a foreign key
  -- check takes, which keeps every other insert on this membership moving.
  select m.status into v_status
  from public.league_memberships m
  where m.id = new.membership_id
  for share;

  if v_status <> 'active' then
    raise exception 'MEMBERSHIP_REQUIRED: that member is not active in this league'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger match_signups_guard_membership_active
  before insert on public.match_signups
  for each row execute function public.match_signups_guard_membership_active();

revoke execute on function public.match_signups_guard_membership_active() from public;

comment on function public.match_signups_guard_membership_active() is
  'Orders a new signup against a concurrent suspension or removal by taking a '
  'share lock on the membership row, which set_membership_status() takes FOR '
  'UPDATE. Only for new rows that hold a place: an existing signup is already '
  'ordered by the match row lock, and locking it here would invert the order.';


-- The other half. Taking the membership row exclusively before anything else
-- means a signup racing this one either commits first — and is then found by
-- the scan below — or waits and reads the suspension.
create or replace function public.set_membership_status(
  p_membership_id uuid,
  p_status public.membership_status,
  p_reason text default null,
  p_suspended_until timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_membership public.league_memberships;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_match record;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  -- FIRST STATEMENT, and it locks. See the header: this is the only row a
  -- concurrent signup and this transaction are guaranteed to have in common.
  --
  -- FOR NO KEY UPDATE, NOT FOR UPDATE. Every insert that references a
  -- membership — a team assignment, a publication entry, a signup — takes a
  -- FOR KEY SHARE lock on the membership row to check the foreign key, and
  -- those inserts happen while their transaction holds the match row lock. A
  -- plain FOR UPDATE here blocks them, so this transaction would hold the
  -- membership and want the match while they hold the match and want the
  -- membership: a deadlock, reliably, on nothing more exotic than publishing
  -- teams while suspending somebody. FOR NO KEY UPDATE leaves foreign keys
  -- alone and still excludes the FOR SHARE the signup guard takes.
  select * into v_membership
  from public.league_memberships m where m.id = p_membership_id
  for no key update;

  -- Not found and not-your-league answer identically, so a guessed id cannot
  -- confirm that a membership exists in a league the caller cannot see.
  if not found or not public.is_league_admin(v_membership.league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  if p_status not in ('active', 'suspended', 'removed') then
    raise exception 'VALIDATION_FAILED: % is not a status an administrator sets', p_status
      using errcode = 'P0001';
  end if;

  -- THE SOLE ADMINISTRATOR IS PROTECTED HERE AS WELL AS BY THE DEFERRED
  -- CONSTRAINT. The Phase 1 trigger would refuse this at COMMIT anyway, but it
  -- reports a cardinality violation; an administrator who suspends themselves
  -- deserves to be told to transfer administration first.
  if v_membership.role = 'league_admin' and p_status <> 'active' then
    raise exception
      'ADMIN_TRANSFER_INVALID: transfer administration before suspending or removing this member'
      using errcode = 'P0001';
  end if;

  if p_status in ('suspended', 'removed') and v_reason is null then
    raise exception 'VALIDATION_FAILED: a reason is required' using errcode = 'P0001';
  end if;

  -- `suspended_until` is informational. Nothing expires it — there is no job
  -- that reactivates anybody, and adding one would let a member silently regain
  -- access with no administrator deciding it. Reactivation stays deliberate.
  update public.league_memberships
     set status = p_status,
         status_reason = v_reason,
         suspended_until = case when p_status = 'suspended' then p_suspended_until end
   where id = p_membership_id;

  -- ── The cascade ─────────────────────────────────────────────────────────
  --
  -- Only for future matches, and only when the member is losing access.
  -- Attendance for matches already played is history and stays untouched.
  --
  -- Ordered by id so two concurrent status changes touching overlapping matches
  -- take the locks in the same sequence and cannot deadlock.
  if p_status in ('suspended', 'removed') then
    for v_match in
      select m.id
      from public.matches m
      join public.match_signups s on s.match_id = m.id
      where m.league_id = v_membership.league_id
        and s.membership_id = p_membership_id
        and s.status in ('interested', 'confirmed', 'waitlisted')
        and m.status not in ('canceled', 'completed')
        and m.kickoff_at > now()
      order by m.id
      for update of m
    loop
      perform public.withdraw_membership_from_match(v_match.id, p_membership_id, v_actor);
    end loop;
  end if;

  -- NO AUDIT CALL HERE. `league_memberships_audit_change` has recorded
  -- `membership.status_changed` since Phase 1 for any authenticated change by
  -- any path, and logging again would put two rows in the trail for one
  -- decision. The reason reaches that event through `status_reason`.
  return p_membership_id;
end;
$$;

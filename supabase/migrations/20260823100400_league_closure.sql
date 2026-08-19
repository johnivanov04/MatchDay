-- MatchDay — closing a league.
--
-- ── WHY THIS EXISTS, AND WHY IT IS SCOPED THE WAY IT IS ────────────────────
--
-- Account deletion cannot proceed while somebody administers an open league:
-- every league has exactly one active administrator, enforced by a partial
-- unique index and a deferred constraint trigger, and deleting the only one
-- would leave it with none.
--
-- "Transfer administration first" answers that for an administrator who has
-- somebody to transfer *to*. `transfer_league_administration` requires an
-- active player in the same league, so an administrator whose league has no
-- other active member is told to do something they cannot do — a screen whose
-- only instruction is impossible for the person reading it. Apple requires an
-- in-app path to deletion; a dead end is not one.
--
-- Closing is the other answer, and it is offered to *every* administrator
-- rather than only to the trapped ones: winding a league down is a legitimate
-- thing to do, and conscripting a successor to escape your own account deletion
-- is not a product decision anybody should be forced into.
--
-- ── WHAT CLOSING IS NOT ────────────────────────────────────────────────────
--
-- It is not deletion. No league row, no match, no roster, no attendance record
-- and no team sheet is removed. Completed fixtures stay exactly as they were —
-- the whole point of the account-deletion architecture is that history survives
-- people leaving, and it would be strange for the league itself to be the
-- exception.
--
-- There is deliberately no reopen path and no general-purpose "close my league"
-- screen in this change. Closure is reachable only from account deletion, where
-- it solves a specific problem. `closed_at` is nullable, so a considered reopen
-- feature remains possible later; nothing here should be read as that feature
-- half-built.

alter table public.leagues add column closed_at timestamptz;

comment on column public.leagues.closed_at is
  'When the league was permanently closed. A closed league accepts no new '
  'members, matches or administration changes and is absent from discovery, '
  'but keeps every historical match, roster and attendance record.';

-- Partial: the interesting set is small and the predicate every read uses is
-- `closed_at is null`.
create index leagues_open_idx on public.leagues (id) where closed_at is null;


-- ══ The cardinality invariant, narrowed in exactly one direction ═══════════
--
-- `league_memberships_single_active_admin_key` — the partial unique index on
-- (league_id) where role = 'league_admin' and status = 'active' — is UNTOUCHED.
-- Two active administrators remain impossible for open and closed leagues
-- alike, which is the half of the invariant that protects against confusion
-- about who is in charge.
--
-- Only the *lower* bound becomes conditional. An open league must still have
-- exactly one; a closed league may have zero, because its administrator has
-- gone and nobody is being appointed in their place.
--
-- The trigger already runs at COMMIT rather than per statement, which is what
-- lets closure and departure land in one transaction in either order.
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
  v_closed_at timestamptz;
begin
  if tg_table_name = 'leagues' then
    v_league_ids := array[new.id];
  elsif tg_op = 'DELETE' then
    v_league_ids := array[old.league_id];
  elsif tg_op = 'INSERT' then
    v_league_ids := array[new.league_id];
  else
    v_league_ids := array[new.league_id, old.league_id];
  end if;

  foreach v_league_id in array v_league_ids loop
    select l.closed_at into v_closed_at
    from public.leagues l where l.id = v_league_id;

    -- FOUND, not "exists": the league may have been deleted later in the same
    -- transaction, and a cardinality rule about a league that no longer exists
    -- is vacuous.
    if found then
      select count(*)
        into v_admin_count
        from public.league_memberships m
       where m.league_id = v_league_id
         and m.role = 'league_admin'
         and m.status = 'active';

      -- A closed league is allowed zero. It is still not allowed two — the
      -- unique index sees to that, for every league, always.
      if v_closed_at is null and v_admin_count <> 1 then
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
  'Deferred constraint trigger. An OPEN league commits with exactly one active '
  'league_admin; a CLOSED league may commit with zero. Two remains impossible '
  'for both, via league_memberships_single_active_admin_key.';


-- ══ A closed league is not a place anything new happens ════════════════════
--
-- Guard triggers rather than edits to `request_to_join_league`,
-- `redeem_league_invite`, `create_match` and `create_and_publish_match`. The
-- same reasoning as the live-profile guards: the rule is about rows, stating it
-- once on the table covers every path including the ones nobody has written
-- yet, and copying four long function bodies into this migration to insert one
-- line into each is how the copies and the originals drift apart.

create or replace function public.matches_guard_league_open()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.leagues l where l.id = new.league_id and l.closed_at is not null) then
    raise exception 'LEAGUE_CLOSED: that league has been closed'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger matches_guard_league_open
  before insert on public.matches
  for each row execute function public.matches_guard_league_open();

revoke execute on function public.matches_guard_league_open() from public;


create or replace function public.league_join_requests_guard_league_open()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.leagues l where l.id = new.league_id and l.closed_at is not null) then
    raise exception 'LEAGUE_CLOSED: that league has been closed'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger league_join_requests_guard_league_open
  before insert on public.league_join_requests
  for each row execute function public.league_join_requests_guard_league_open();

revoke execute on function public.league_join_requests_guard_league_open() from public;


-- Memberships: nobody joins, is promoted, or is reactivated in a closed league.
--
-- `removed` is exempt for the same reason it is exempt from the live-profile
-- guard — it is the direction cleanup moves, and a rule that blocked it would
-- block the account deletion that closure exists to unblock.
create or replace function public.league_memberships_guard_league_open()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'removed' then
    return new;
  end if;

  -- An UPDATE that changes nothing relevant — a status_reason edit on an
  -- existing row, say — is not somebody joining a closed league.
  if tg_op = 'UPDATE'
     and new.status = old.status
     and new.role = old.role then
    return new;
  end if;

  if exists (select 1 from public.leagues l where l.id = new.league_id and l.closed_at is not null) then
    raise exception 'LEAGUE_CLOSED: that league has been closed'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger league_memberships_guard_league_open
  before insert or update on public.league_memberships
  for each row execute function public.league_memberships_guard_league_open();

revoke execute on function public.league_memberships_guard_league_open() from public;


-- ── Discovery ──────────────────────────────────────────────────────────────
--
-- A closed league leaves search the moment it closes. Somebody finding it and
-- asking to join would be refused by the guard above, which is correct but is
-- an error message where there should simply have been no result.
create or replace view public.searchable_leagues_public as
  select id, slug, name, general_area, sport_label, typical_schedule, description
  from public.leagues
  where visibility = 'searchable' and closed_at is null;


-- ══ close_league ═══════════════════════════════════════════════════════════
--
-- Administrator-only, and self-scoped in the sense that matters: it takes a
-- league, and the caller must be that league's current administrator. There is
-- no membership or user id to forge.
--
-- Order is deliberate. Matches are cancelled BEFORE `closed_at` is set, because
-- `cancel_match` is the canonical cancellation and it calls `is_league_admin`,
-- which is a question about an administrator of an open league. Setting
-- `closed_at` first would make the function unable to use its own primitive.
create or replace function public.close_league(p_league_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_league public.leagues;
  v_match record;
  v_notified integer;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  select * into v_league from public.leagues l where l.id = p_league_id;

  -- A league that does not exist and a league somebody else administers answer
  -- identically, so a guessed id confirms nothing.
  if not found or not public.is_league_admin(p_league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  -- Idempotent. Closing twice is the same league in the same state, and the
  -- deletion flow may well retry.
  if v_league.closed_at is not null then
    return p_league_id;
  end if;

  -- ── Future matches ──────────────────────────────────────────────────────
  --
  -- Through `cancel_match`, which owns what cancelling means: the audit event,
  -- the `match_canceled` fanout to every active member, and leaving a draft
  -- silent because nobody ever saw it. Ordered by id so two concurrent
  -- operations touching the same matches take their locks in the same sequence.
  --
  -- Completed and already-cancelled matches are not in the scan. A league
  -- closing does not un-play its fixtures.
  for v_match in
    select m.id
    from public.matches m
    where m.league_id = p_league_id
      and m.status not in ('canceled', 'completed')
      and m.kickoff_at > now()
    order by m.id
    for update
  loop
    perform public.cancel_match(v_match.id, 'The league has been closed.');
  end loop;

  update public.leagues set closed_at = now() where id = p_league_id;

  perform public.log_audit_event(
    p_league_id, v_actor, 'league', p_league_id, 'league.closed',
    jsonb_build_object('closed_at', null),
    jsonb_build_object('closed_at', now()),
    null
  );

  -- ── Telling the members ─────────────────────────────────────────────────
  --
  -- One notification each, in-app, excluding the administrator who just did it.
  -- The per-match cancellations above have already told them what they are
  -- missing this week; this says why, once, so an empty fixture list is not the
  -- only explanation anybody gets.
  --
  -- Keyed on the league alone, so a retried closure cannot produce a second
  -- one — `create_notification` is ON CONFLICT DO NOTHING over that key.
  v_notified := public.notify_league_members(
    p_league_id, 'league_closed',
    'League closed',
    v_league.name || ' has been closed.',
    '/dashboard',
    'league_closed:' || p_league_id::text,
    null, v_actor,
    '{}'::jsonb
  );

  return p_league_id;
end;
$$;

comment on function public.close_league(uuid) is
  'Permanently closes a league: cancels every future match through '
  'cancel_match(), sets closed_at, audits it, and notifies each other active '
  'member in-app. Deletes nothing. Administrator-only and idempotent.';

revoke execute on function public.close_league(uuid) from public;
grant execute on function public.close_league(uuid) to authenticated, service_role;

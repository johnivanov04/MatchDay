-- Matchday — Phase 4B/4C/4D/4E
-- Eligibility, and the four things a player can do about a match.
--
-- Every one of these runs as SECURITY DEFINER with `search_path = ''`, derives
-- the actor from auth.uid(), and resolves the membership itself. Nothing here
-- accepts a user id, a membership id, a league id, a role, a guideline state or
-- a priority flag from the caller — the only parameter is which match, and even
-- that is answered identically whether it does not exist or the caller may not
-- see it.


-- ── The caller's active membership ─────────────────────────────────────────

create or replace function public.my_active_membership_id(p_league_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id
  from public.league_memberships m
  where m.league_id = p_league_id
    and m.user_id = auth.uid()
    and m.status = 'active';
$$;


-- ── One authoritative eligibility path ─────────────────────────────────────
--
-- Returns a stable domain code from 02 §21 rather than a boolean, because the
-- interface has to explain *why* a player cannot sign up — "you have not
-- accepted the guidelines" and "signup closed an hour ago" need different
-- screens. Every player-facing write below calls this and refuses unless it
-- answers ELIGIBLE, so the rule exists once.
--
-- ORDER IS DELIBERATE. Membership is checked before anything about the match,
-- so a non-member learns only that they are not a member — never whether a
-- match exists, whether it is open, or when its deadline falls. An unknown
-- match id and a match in a league the caller is not in produce the identical
-- answer for the same reason.
--
-- This is a *product* rule check, not the security boundary. Row Level Security
-- and the administrator checks inside each function are independent of it.
create or replace function public.match_signup_eligibility(p_match_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_membership uuid;
begin
  if v_actor is null then
    return 'AUTH_REQUIRED';
  end if;

  select * into v_match from public.matches m where m.id = p_match_id;

  -- Not found and not-your-league are the same answer, deliberately.
  if not found then
    return 'MEMBERSHIP_REQUIRED';
  end if;

  v_membership := public.my_active_membership_id(v_match.league_id);
  if v_membership is null then
    return 'MEMBERSHIP_REQUIRED';
  end if;

  -- Phase 3's predicate, reused rather than reimplemented. It answers only
  -- about the caller and only about this league, which is what makes a player
  -- eligible in one league and blocked in another (02 §8).
  if not public.has_accepted_required_guidelines(v_match.league_id) then
    return 'GUIDELINES_NOT_ACCEPTED';
  end if;

  -- A match the caller cannot see is answered exactly as one that does not
  -- exist. This function reads the match as its owner, so without this line a
  -- member who guessed a draft's identifier would learn from a MATCH_NOT_OPEN
  -- answer that it exists — the one thing `matches_select_member` is there to
  -- prevent. `published_at is not null` is the same reliable proxy for "has
  -- ever been visible" that the Phase 3 policy uses.
  if v_match.published_at is null then
    return 'MEMBERSHIP_REQUIRED';
  end if;

  -- Canceled matches take no responses, and a finalized roster is closed to
  -- new self-service signups.
  if v_match.status <> 'open' then
    return 'MATCH_NOT_OPEN';
  end if;

  if now() >= v_match.signup_closes_at then
    return 'SIGNUP_CLOSED';
  end if;

  return 'ELIGIBLE';
end;
$$;

comment on function public.match_signup_eligibility(uuid) is
  'The single eligibility rule for player signup. Returns ELIGIBLE or a 02 §21 '
  'domain code. Membership is evaluated first so a non-member learns nothing '
  'about the match.';


-- ── What a signup operation returns ────────────────────────────────────────
--
-- The caller's own outcome and, when waitlisted, their own position. Never
-- anybody else's: there is no field here that could carry another player's
-- identity or place in the queue.
create type public.signup_outcome as (
  status public.signup_status,
  waitlist_position integer
);


-- ── Shared internals ───────────────────────────────────────────────────────

-- Confirmed headcount. Reads through the same predicate the partial index uses,
-- so "what counts against capacity" has exactly one definition.
create or replace function public.match_confirmed_count(p_match_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.match_signups s
  where s.match_id = p_match_id
    and public.signup_consumes_capacity(s.status);
$$;

-- The next free waitlist position. Called only while the match row is locked,
-- which is what makes "max + 1" safe rather than a race.
create or replace function public.next_waitlist_position(p_match_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(max(s.waitlist_position), 0) + 1
  from public.match_signups s
  where s.match_id = p_match_id
    and s.status = 'waitlisted';
$$;


-- Closes gaps left by somebody leaving the waitlist, so positions stay 1..N
-- contiguous. Callers hold the match row lock.
--
-- The unique constraint is deferred for the duration because renumbering is a
-- permutation: shifting 3→2 while 2 still exists collides mid-statement even
-- though the final state is valid. Deferring moves the check to COMMIT, where
-- the state is the one that matters. `set constraints` is transaction-scoped,
-- so this does not weaken the constraint for anything else.
create or replace function public.compact_waitlist(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  set constraints public.match_signups_waitlist_position_key deferred;

  with ordered as (
    select s.id,
           row_number() over (order by s.waitlist_position, s.responded_at, s.id) as position
    from public.match_signups s
    where s.match_id = p_match_id
      and s.status = 'waitlisted'
  )
  update public.match_signups s
     set waitlist_position = ordered.position
    from ordered
   where s.id = ordered.id
     and s.waitlist_position is distinct from ordered.position;
end;
$$;


-- ── Join a first-come match ────────────────────────────────────────────────
--
-- CONCURRENCY IS THE WHOLE POINT OF THIS FUNCTION.
--
-- `select ... for update` on the match row is the first thing it does. Every
-- other function that can change the confirmed headcount takes the same lock on
-- the same row first, so all capacity decisions for one match are serialized
-- and none can deadlock against another. Two players tapping Join at the same
-- instant queue behind each other: the first sees the true count and takes the
-- last slot, the second sees the count *including* that slot and is waitlisted.
--
-- Counting first and writing afterwards without the lock is the classic version
-- of this bug — both transactions read the same count, both write, and the
-- match ends up over capacity with no constraint violated.
create or replace function public.join_match(p_match_id uuid)
returns public.signup_outcome
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_membership uuid;
  v_eligibility text;
  v_existing public.match_signups;
  v_confirmed integer;
  v_status public.signup_status;
  v_position integer;
  v_priority boolean;
  v_slug text;
  v_outcome public.signup_outcome;
begin
  -- Take the lock before reading anything that the decision depends on.
  select * into v_match from public.matches m where m.id = p_match_id for update;

  v_eligibility := public.match_signup_eligibility(p_match_id);
  if v_eligibility <> 'ELIGIBLE' then
    raise exception '%: signup refused', v_eligibility using errcode = '42501';
  end if;

  if v_match.selection_mode <> 'first_come' then
    raise exception
      'SIGNUP_MODE_MISMATCH: this match selects its roster by administrator approval'
      using errcode = 'P0001';
  end if;

  v_membership := public.my_active_membership_id(v_match.league_id);

  select * into v_existing
  from public.match_signups s
  where s.match_id = p_match_id and s.membership_id = v_membership;

  -- Idempotent by outcome, not by request. A second tap, a double-submit or a
  -- retry after a lost response all return what the player already holds
  -- instead of claiming a second slot or a second waitlist position.
  if found and v_existing.status in ('confirmed', 'waitlisted') then
    v_outcome := (v_existing.status, v_existing.waitlist_position);
    return v_outcome;
  end if;

  -- Derived here, never supplied. A player cannot claim priority.
  v_priority := case
    when v_match.priority_window_ends_at is null then null
    else now() <= v_match.priority_window_ends_at
  end;

  v_confirmed := public.match_confirmed_count(p_match_id);

  if v_confirmed < v_match.capacity then
    v_status := 'confirmed';
    v_position := null;
  else
    v_status := 'waitlisted';
    v_position := public.next_waitlist_position(p_match_id);
  end if;

  insert into public.match_signups (
    league_id, match_id, membership_id, status, responded_at,
    priority_qualified, waitlist_position
  )
  values (
    v_match.league_id, p_match_id, v_membership, v_status, now(),
    v_priority, v_position
  )
  on conflict (match_id, membership_id) do update
    set status = excluded.status,
        responded_at = excluded.responded_at,
        priority_qualified = excluded.priority_qualified,
        waitlist_position = excluded.waitlist_position,
        -- A self-service join is not an administrator decision.
        selected_by = null,
        selected_at = null,
        override_reason = null;

  select l.slug into v_slug from public.leagues l where l.id = v_match.league_id;

  -- One notification per player per match per outcome. A retry that reaches
  -- this line cannot happen (it returned early above), and the key makes it
  -- harmless if a future path ever does.
  perform public.create_notification(
    v_actor, v_match.league_id,
    case when v_status = 'confirmed' then 'signup_confirmed'::public.notification_type
         else 'waitlisted'::public.notification_type end,
    case when v_status = 'confirmed' then 'You are in: ' || v_match.title
         else 'Waitlisted: ' || v_match.title end,
    case when v_status = 'confirmed'
         then to_char(v_match.kickoff_at at time zone v_match.timezone, 'Dy DD Mon HH24:MI')
              || ' at ' || v_match.location_name
         else 'You are number ' || v_position::text || ' on the waitlist.' end,
    '/leagues/' || v_slug || '/matches/' || p_match_id::text,
    case when v_status = 'confirmed'
         then 'signup_confirmed:' || p_match_id::text || ':' || v_membership::text
         else 'waitlisted:' || p_match_id::text || ':' || v_membership::text end,
    p_match_id,
    jsonb_build_object('push_eligible', true)
  );

  v_outcome := (v_status, v_position);
  return v_outcome;
end;
$$;


-- ── Request a spot in an administrator-approved match ──────────────────────
--
-- Consumes no capacity and promises nothing. The status is `interested`, which
-- signup_consumes_capacity() deliberately excludes, so a match cannot fill up
-- with requests before the administrator has decided anything.
create or replace function public.request_spot(p_match_id uuid)
returns public.signup_outcome
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_membership uuid;
  v_eligibility text;
  v_existing public.match_signups;
  v_priority boolean;
  v_slug text;
  v_outcome public.signup_outcome;
begin
  -- No capacity decision is made here, but the same lock is taken so that a
  -- request and an administrator decision on the same match cannot interleave
  -- half-way through each other.
  select * into v_match from public.matches m where m.id = p_match_id for update;

  v_eligibility := public.match_signup_eligibility(p_match_id);
  if v_eligibility <> 'ELIGIBLE' then
    raise exception '%: signup refused', v_eligibility using errcode = '42501';
  end if;

  if v_match.selection_mode <> 'admin_approval' then
    raise exception 'SIGNUP_MODE_MISMATCH: this match confirms players immediately'
      using errcode = 'P0001';
  end if;

  v_membership := public.my_active_membership_id(v_match.league_id);

  select * into v_existing
  from public.match_signups s
  where s.match_id = p_match_id and s.membership_id = v_membership;

  -- Never overwrite a decision the administrator has already made. Re-tapping
  -- "Request a spot" after being confirmed, waitlisted or passed over returns
  -- the standing outcome rather than resetting it to a fresh request.
  if found and v_existing.status in ('interested', 'confirmed', 'waitlisted', 'not_selected') then
    v_outcome := (v_existing.status, v_existing.waitlist_position);
    return v_outcome;
  end if;

  v_priority := case
    when v_match.priority_window_ends_at is null then null
    else now() <= v_match.priority_window_ends_at
  end;

  insert into public.match_signups (
    league_id, match_id, membership_id, status, responded_at, priority_qualified
  )
  values (v_match.league_id, p_match_id, v_membership, 'interested', now(), v_priority)
  on conflict (match_id, membership_id) do update
    set status = 'interested',
        responded_at = excluded.responded_at,
        priority_qualified = excluded.priority_qualified,
        waitlist_position = null,
        selected_by = null,
        selected_at = null,
        override_reason = null;

  select l.slug into v_slug from public.leagues l where l.id = v_match.league_id;

  perform public.create_notification(
    v_actor, v_match.league_id, 'signup_pending',
    'Request received: ' || v_match.title,
    'The administrator will confirm the roster. You do not have a spot yet.',
    '/leagues/' || v_slug || '/matches/' || p_match_id::text,
    'signup_pending:' || p_match_id::text || ':' || v_membership::text,
    p_match_id,
    jsonb_build_object('push_eligible', false)
  );

  v_outcome := ('interested', null);
  return v_outcome;
end;
$$;


-- ── "Can't play" ───────────────────────────────────────────────────────────
--
-- The Phase 4 availability response, and deliberately NOT a back door into
-- Phase 5 cancellation.
--
-- A player who has not been given a confirmed spot may say they are
-- unavailable: nobody was counting on them, no slot is released, nobody needs
-- promoting and there is no cutoff to classify against. A *confirmed* player
-- saying the same thing is cancellation — it frees capacity, may be late, owes
-- the administrator an alert and may trigger a promotion. None of that exists
-- yet, so this refuses rather than performing the visible half of it and
-- silently skipping the rest.
create or replace function public.mark_unavailable(p_match_id uuid)
returns public.signup_outcome
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match public.matches;
  v_membership uuid;
  v_eligibility text;
  v_existing public.match_signups;
  v_outcome public.signup_outcome;
begin
  select * into v_match from public.matches m where m.id = p_match_id for update;

  v_eligibility := public.match_signup_eligibility(p_match_id);
  if v_eligibility <> 'ELIGIBLE' then
    raise exception '%: signup refused', v_eligibility using errcode = '42501';
  end if;

  v_membership := public.my_active_membership_id(v_match.league_id);

  select * into v_existing
  from public.match_signups s
  where s.match_id = p_match_id and s.membership_id = v_membership;

  if found and v_existing.status = 'confirmed' then
    raise exception
      'SIGNUP_CANCELLATION_UNAVAILABLE: cancelling a confirmed spot is not implemented yet'
      using errcode = 'P0001';
  end if;

  if found and v_existing.status = 'not_available' then
    v_outcome := ('not_available', null);
    return v_outcome;
  end if;

  insert into public.match_signups (
    league_id, match_id, membership_id, status, responded_at
  )
  values (v_match.league_id, p_match_id, v_membership, 'not_available', now())
  on conflict (match_id, membership_id) do update
    set status = 'not_available',
        responded_at = excluded.responded_at,
        -- Leaving the waitlist frees the position for everybody behind them.
        waitlist_position = null,
        selected_by = null,
        selected_at = null,
        override_reason = null;

  -- Closing the gap keeps positions 1..N contiguous, so the person who was
  -- third does not stay third with nobody second.
  perform public.compact_waitlist(p_match_id);

  -- No notification. The player performed this themselves and already knows;
  -- the administrator sees it in the roster workspace.
  v_outcome := ('not_available', null);
  return v_outcome;
end;
$$;

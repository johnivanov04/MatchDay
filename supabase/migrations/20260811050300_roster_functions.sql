-- Matchday — Phase 4E/4G/4I/4J
-- The administrator's roster decisions.
--
-- Every function here: locks the match row first (the same lock join_match()
-- takes, so a decision and a player's join cannot interleave), re-derives the
-- administrator from auth.uid(), reports "not found" and "not your league"
-- identically, writes an audit event, and preserves capacity and waitlist
-- invariants inside one transaction.
--
-- None of them notifies. Notification is what finalize_roster() does, once,
-- per 02 §11 — "Finalization creates one outcome notification per affected
-- player". Announcing each intermediate click would train members to ignore
-- the message that actually matters, and would tell somebody they were cut
-- while the administrator was still moving names around.


-- ── Shared administrator guard ─────────────────────────────────────────────
--
-- Returns the locked match row, or raises the same NOT_LEAGUE_ADMIN whether the
-- match does not exist, belongs to another league, or the caller is merely a
-- player. Anti-enumeration, matching Phase 2 and Phase 3B.
create or replace function public.lock_match_as_admin(p_match_id uuid)
returns public.matches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match public.matches;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  select * into v_match from public.matches m where m.id = p_match_id for update;

  if not found or not public.is_league_admin(v_match.league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  return v_match;
end;
$$;


-- ── Set one player's decision ──────────────────────────────────────────────
--
-- Confirm, waitlist, or pass over a single player. One function rather than
-- three because they share every invariant — capacity, waitlist contiguity,
-- selection metadata, the audit event — and three copies would be three places
-- for those to drift.
--
-- `p_membership_id` is the *target*, never the actor. The actor is auth.uid();
-- a caller supplying somebody else's membership id can only act on a member of
-- a league they already administer, which the composite lookup below enforces.
create or replace function public.set_signup_decision(
  p_match_id uuid,
  p_membership_id uuid,
  p_status public.signup_status,
  p_reason text default null
)
returns public.signup_outcome
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_membership public.league_memberships;
  v_existing public.match_signups;
  v_confirmed integer;
  v_position integer;
  v_outcome public.signup_outcome;
begin
  v_match := public.lock_match_as_admin(p_match_id);

  if p_status not in ('interested', 'confirmed', 'waitlisted', 'not_selected') then
    raise exception 'SIGNUP_DECISION_INVALID: % is not an administrator decision', p_status
      using errcode = 'P0001';
  end if;

  -- Scoped by league as well as id, so a membership from another tenant is
  -- simply not found — the same answer as an id that does not exist.
  select * into v_membership
  from public.league_memberships m
  where m.id = p_membership_id and m.league_id = v_match.league_id;

  if not found then
    raise exception 'MEMBERSHIP_REQUIRED: no such member of this league'
      using errcode = '42501';
  end if;

  -- A hard invariant, not an overrideable rule: a suspended or removed member
  -- is not entitled to member-only content, and a roster is member-only content.
  if v_membership.status <> 'active' and p_status in ('confirmed', 'waitlisted') then
    raise exception 'MEMBERSHIP_INACTIVE: that member is not active in this league'
      using errcode = '42501';
  end if;

  select * into v_existing
  from public.match_signups s
  where s.match_id = p_match_id and s.membership_id = p_membership_id;

  if found and v_existing.status = p_status then
    -- Idempotent: pressing Confirm twice is one decision.
    v_outcome := (v_existing.status, v_existing.waitlist_position);
    return v_outcome;
  end if;

  -- Capacity is evaluated under the lock taken above, so two administrators
  -- confirming the last spot at the same time cannot both succeed.
  if p_status = 'confirmed' then
    v_confirmed := public.match_confirmed_count(p_match_id);
    if v_confirmed >= v_match.capacity then
      raise exception 'CAPACITY_EXCEEDED: this match is already at capacity'
        using errcode = 'P0001';
    end if;
  end if;

  if p_status = 'waitlisted' then
    v_position := public.next_waitlist_position(p_match_id);
  else
    v_position := null;
  end if;

  insert into public.match_signups (
    league_id, match_id, membership_id, status, responded_at,
    waitlist_position, selected_by, selected_at, override_reason
  )
  values (
    v_match.league_id, p_match_id, p_membership_id, p_status,
    coalesce(v_existing.responded_at, now()),
    v_position, v_actor, now(), nullif(btrim(coalesce(p_reason, '')), '')
  )
  on conflict (match_id, membership_id) do update
    set status = excluded.status,
        -- Leaving the waitlist drops the position in the same statement, so a
        -- confirmed player can never also hold a place in the queue.
        waitlist_position = excluded.waitlist_position,
        selected_by = excluded.selected_by,
        selected_at = excluded.selected_at,
        override_reason = excluded.override_reason;

  -- Whoever was behind them moves up.
  perform public.compact_waitlist(p_match_id);

  select s.waitlist_position into v_position
  from public.match_signups s
  where s.match_id = p_match_id and s.membership_id = p_membership_id;

  -- Membership id, not user id, and no name, position, gender or note: an
  -- audit row is readable by every future administrator of the league.
  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match_signup', p_match_id, 'roster.decision',
    jsonb_build_object('membership_id', p_membership_id,
                       'status', coalesce(v_existing.status::text, null)),
    jsonb_build_object('membership_id', p_membership_id,
                       'status', p_status::text,
                       'waitlist_position', v_position),
    nullif(btrim(coalesce(p_reason, '')), '')
  );

  v_outcome := (p_status, v_position);
  return v_outcome;
end;
$$;


-- ── Reorder the waitlist ───────────────────────────────────────────────────
--
-- The administrator supplies the membership ids in the order they should sit.
-- The database validates the set rather than trusting it: same match, same
-- league, currently waitlisted, no duplicates, and complete. A partial reorder
-- is refused because "the ids you left out keep their old numbers" has no
-- meaning once the others have moved — the result would have gaps or
-- collisions depending on what was omitted.
--
-- The unique constraint is deferred, because renumbering is a permutation and
-- any statement order collides part-way through. Deferring checks the state
-- that matters, at COMMIT, so a legitimate reorder cannot fail on an
-- intermediate state.
create or replace function public.reorder_waitlist(
  p_match_id uuid,
  p_membership_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_current uuid[];
  v_before jsonb;
begin
  v_match := public.lock_match_as_admin(p_match_id);

  if p_membership_ids is null or array_length(p_membership_ids, 1) is null then
    raise exception 'WAITLIST_CONFLICT: no ordering supplied' using errcode = 'P0001';
  end if;

  if array_length(p_membership_ids, 1)
     <> (select count(distinct id) from unnest(p_membership_ids) id) then
    raise exception 'WAITLIST_CONFLICT: the ordering repeats a player'
      using errcode = 'P0001';
  end if;

  -- The set as it stands, in current order, for both validation and the audit.
  select array_agg(s.membership_id order by s.waitlist_position)
    into v_current
  from public.match_signups s
  where s.match_id = p_match_id and s.status = 'waitlisted';

  -- Set equality. Catches a foreign id, an id from another league, a player who
  -- is not waitlisted, and an omission — all of which would corrupt the
  -- ordering in different ways.
  if coalesce(v_current, '{}') <@ p_membership_ids = false
     or p_membership_ids <@ coalesce(v_current, '{}') = false then
    raise exception
      'WAITLIST_CONFLICT: the ordering must list exactly the waitlisted players'
      using errcode = 'P0001';
  end if;

  v_before := to_jsonb(v_current);

  set constraints public.match_signups_waitlist_position_key deferred;

  update public.match_signups s
     set waitlist_position = requested.position
    from (
      select id as membership_id, ordinality::integer as position
      from unnest(p_membership_ids) with ordinality as t(id, ordinality)
    ) as requested
   where s.match_id = p_match_id
     and s.membership_id = requested.membership_id
     and s.waitlist_position is distinct from requested.position;

  -- Membership ids only. The order itself is the administrative fact; who those
  -- people are is not recorded here.
  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match_signup', p_match_id, 'roster.waitlist_reordered',
    jsonb_build_object('order', v_before),
    jsonb_build_object('order', to_jsonb(p_membership_ids)),
    null
  );

  return array_length(p_membership_ids, 1);
end;
$$;


-- ── Manually add an existing active member ─────────────────────────────────
--
-- Operates on a membership that already exists and is active. There is no
-- parameter for an email address or a user id, so this cannot be used to pull
-- somebody into a league, and it is not a guest workflow.
--
-- OVERRIDE POLICY. F-06 lists the eligibility checks and marks exactly one as
-- overrideable: "signup deadline has not passed, *unless administrator
-- override*". So a closed deadline may be overridden, with a reason recorded.
-- Active membership and accepted guidelines are not overrideable — no document
-- grants that, and inventing the permission would let an administrator put
-- somebody on a roster who has not agreed to the league's rules.
create or replace function public.add_member_to_match(
  p_match_id uuid,
  p_membership_id uuid,
  p_status public.signup_status,
  p_override_reason text default null
)
returns public.signup_outcome
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_membership public.league_memberships;
  v_existing public.match_signups;
  v_confirmed integer;
  v_position integer;
  v_reason text := nullif(btrim(coalesce(p_override_reason, '')), '');
  v_deadline_passed boolean;
  v_outcome public.signup_outcome;
begin
  v_match := public.lock_match_as_admin(p_match_id);

  if p_status not in ('confirmed', 'waitlisted') then
    raise exception 'SIGNUP_DECISION_INVALID: a manual addition is confirmed or waitlisted'
      using errcode = 'P0001';
  end if;

  select * into v_membership
  from public.league_memberships m
  where m.id = p_membership_id and m.league_id = v_match.league_id;

  -- Cross-league and non-existent are the same answer.
  if not found then
    raise exception 'MEMBERSHIP_REQUIRED: no such member of this league'
      using errcode = '42501';
  end if;

  -- Hard invariant.
  if v_membership.status <> 'active' then
    raise exception 'MEMBERSHIP_INACTIVE: that member is not active in this league'
      using errcode = '42501';
  end if;

  -- Hard invariant. The guideline predicate answers about auth.uid(), so it
  -- cannot be reused for a third party; this is the same question asked
  -- directly of the target membership.
  if exists (
    select 1 from public.guideline_versions gv
    where gv.id = public.current_required_guideline_version(v_match.league_id)
  ) and not exists (
    select 1 from public.guideline_acceptances a
    where a.membership_id = p_membership_id
      and a.guideline_version_id = public.current_required_guideline_version(v_match.league_id)
  ) then
    raise exception
      'GUIDELINES_NOT_ACCEPTED: that member has not accepted the current guidelines'
      using errcode = '42501';
  end if;

  if v_match.status <> 'open' and v_match.status <> 'roster_finalized' then
    raise exception 'MATCH_NOT_OPEN: this match is not accepting roster changes'
      using errcode = 'P0001';
  end if;

  -- The one overrideable rule, and the reason is mandatory when it is used.
  v_deadline_passed := now() >= v_match.signup_closes_at;
  if v_deadline_passed and v_reason is null then
    raise exception
      'SIGNUP_CLOSED: signup has closed; supply a reason to add this member anyway'
      using errcode = 'P0001';
  end if;

  select * into v_existing
  from public.match_signups s
  where s.match_id = p_match_id and s.membership_id = p_membership_id;

  if found and v_existing.status = p_status then
    v_outcome := (v_existing.status, v_existing.waitlist_position);
    return v_outcome;
  end if;

  if p_status = 'confirmed' then
    v_confirmed := public.match_confirmed_count(p_match_id);
    if v_confirmed >= v_match.capacity then
      raise exception 'CAPACITY_EXCEEDED: this match is already at capacity'
        using errcode = 'P0001';
    end if;
    v_position := null;
  else
    v_position := public.next_waitlist_position(p_match_id);
  end if;

  -- Updates the existing row rather than adding a second one; the unique
  -- constraint on (match_id, membership_id) makes that the only possibility.
  insert into public.match_signups (
    league_id, match_id, membership_id, status, responded_at,
    waitlist_position, selected_by, selected_at, override_reason
  )
  values (
    v_match.league_id, p_match_id, p_membership_id, p_status,
    coalesce(v_existing.responded_at, now()),
    v_position, v_actor, now(), v_reason
  )
  on conflict (match_id, membership_id) do update
    set status = excluded.status,
        waitlist_position = excluded.waitlist_position,
        selected_by = excluded.selected_by,
        selected_at = excluded.selected_at,
        override_reason = excluded.override_reason;

  perform public.compact_waitlist(p_match_id);

  select s.waitlist_position into v_position
  from public.match_signups s
  where s.match_id = p_match_id and s.membership_id = p_membership_id;

  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match_signup', p_match_id, 'roster.manual_add',
    case when v_existing.id is null then null
         else jsonb_build_object('membership_id', p_membership_id,
                                 'status', v_existing.status::text) end,
    jsonb_build_object('membership_id', p_membership_id,
                       'status', p_status::text,
                       'waitlist_position', v_position,
                       'deadline_overridden', v_deadline_passed),
    v_reason
  );

  v_outcome := (p_status, v_position);
  return v_outcome;
end;
$$;


-- ── Finalize and publish the roster ────────────────────────────────────────
--
-- The moment the decisions become the answer. Increments the roster revision,
-- moves the match to roster_finalized, and sends each affected player exactly
-- one notification saying what happened to them.
--
-- "Affected" is decided by comparing each row's status against
-- `published_status` — the status that player was last told. First publication:
-- everybody with a response hears their outcome. Republication: people whose
-- outcome moved hear the new one; everybody else hears that the roster changed.
-- Both idempotent, because re-running with nothing changed leaves every
-- published_status already equal to status and creates no notifications.
--
-- FIRST-COME MATCHES ARE NOT REQUIRED TO DO THIS. F-06 makes their confirmed
-- roster authoritative the moment a player joins, and 02 §10 requires it be
-- "immediately visible to league members". Forcing an approval step would add a
-- state where the roster is real but unpublished. The function still accepts
-- them, so an administrator who wants to freeze one may.
create or replace function public.finalize_roster(p_match_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_revision integer;
  v_first_publication boolean;
  v_confirmed integer;
  v_slug text;
  v_row record;
  v_type public.notification_type;
  v_title text;
  v_body text;
  v_notified integer := 0;
begin
  v_match := public.lock_match_as_admin(p_match_id);

  if v_match.status not in ('open', 'roster_finalized') then
    raise exception 'MATCH_NOT_OPEN: only an open match can have its roster published'
      using errcode = 'P0001';
  end if;

  -- Belt and braces. The capacity checks above make this unreachable; if it
  -- ever fires, something wrote signups outside these functions.
  v_confirmed := public.match_confirmed_count(p_match_id);
  if v_confirmed > v_match.capacity then
    raise exception 'CAPACITY_EXCEEDED: % confirmed players exceeds capacity %',
      v_confirmed, v_match.capacity using errcode = 'P0001';
  end if;

  -- Nothing to announce: every outcome already matches what was published.
  -- Returning the standing revision makes a repeated press a no-op rather than
  -- a second round of notifications.
  if v_match.roster_finalized_at is not null and not exists (
    select 1 from public.match_signups s
    where s.match_id = p_match_id
      and s.status is distinct from s.published_status
  ) then
    return v_match.roster_revision;
  end if;

  v_first_publication := v_match.roster_finalized_at is null;
  v_revision := v_match.roster_revision + 1;
  v_confirmed := public.match_confirmed_count(p_match_id);

  update public.matches
     set roster_revision = v_revision,
         roster_finalized_at = now(),
         status = 'roster_finalized'
   where id = p_match_id;

  select l.slug into v_slug from public.leagues l where l.id = v_match.league_id;

  for v_row in
    select s.id, s.membership_id, s.status, s.published_status, s.waitlist_position,
           m.user_id
    from public.match_signups s
    join public.league_memberships m on m.id = s.membership_id
    where s.match_id = p_match_id
      and s.status in ('confirmed', 'waitlisted', 'not_selected')
      and m.status = 'active'
  loop
    if v_row.status is not distinct from v_row.published_status then
      -- Unchanged outcome on a republication: told that the roster moved, not
      -- told their own status again.
      v_type := 'roster_changed';
      v_title := 'Roster updated: ' || v_match.title;
      v_body := 'The roster changed. Your place is unchanged.';
    elsif v_row.status = 'confirmed' then
      v_type := case when v_first_publication then 'roster_published'::public.notification_type
                     else 'signup_confirmed'::public.notification_type end;
      v_title := 'You are playing: ' || v_match.title;
      v_body := to_char(v_match.kickoff_at at time zone v_match.timezone, 'Dy DD Mon HH24:MI')
                || ' at ' || v_match.location_name;
    elsif v_row.status = 'waitlisted' then
      v_type := 'waitlisted';
      v_title := 'Waitlisted: ' || v_match.title;
      v_body := 'You are number ' || v_row.waitlist_position::text || ' on the waitlist.';
    else
      v_type := 'not_selected';
      v_title := 'Not selected: ' || v_match.title;
      v_body := 'You were not selected for this match.';
    end if;

    -- Keyed on the revision, so republishing announces again while a retry of
    -- the same publication does not. Nothing about any other player appears in
    -- the key, the title or the body.
    if public.create_notification(
         v_row.user_id, v_match.league_id, v_type, v_title, v_body,
         '/leagues/' || v_slug || '/matches/' || p_match_id::text,
         'roster_outcome:' || p_match_id::text || ':' || v_revision::text
           || ':' || v_row.membership_id::text,
         p_match_id,
         jsonb_build_object('push_eligible', true)
       ) is not null
    then
      v_notified := v_notified + 1;
    end if;
  end loop;

  -- Record what each player was told, so the next publication can tell who
  -- actually moved.
  update public.match_signups s
     set published_status = s.status
   where s.match_id = p_match_id;

  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match', p_match_id, 'roster.published',
    jsonb_build_object('roster_revision', v_match.roster_revision),
    jsonb_build_object('roster_revision', v_revision,
                       'confirmed', v_confirmed,
                       'notified', v_notified),
    null
  );

  return v_revision;
end;
$$;

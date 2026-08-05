-- Matchday — Phase 3B
-- Match template and match operations.
--
-- The timezone arithmetic lives here rather than in the application. A local
-- date plus a wall-clock time is not an instant until a zone resolves it, and
-- `timestamp AT TIME ZONE 'America/Los_Angeles'` is the one implementation in
-- this stack that already knows every daylight-saving rule and keeps knowing
-- them as the tzdata package is updated. Doing the same arithmetic in
-- JavaScript would be a second, drifting source of truth for the field the
-- whole product turns on.

-- ── Create a match ─────────────────────────────────────────────────────────
--
-- Takes local wall-clock times and relative deadline rules — exactly what a
-- template holds and what an administrator types — and resolves them once
-- against the league's own timezone. The caller merges league and template
-- defaults before calling; this function is the single place that turns them
-- into instants.
create or replace function public.create_match(
  p_league_id uuid,
  p_title text,
  p_match_date date,
  p_arrival_time time,
  p_kickoff_time time,
  p_end_time time,
  p_location_name text,
  p_capacity integer,
  p_min_players integer,
  p_selection_mode public.selection_mode,
  p_waitlist_mode public.waitlist_mode,
  p_team_count integer default 2,
  p_template_id uuid default null,
  p_location_map_url text default null,
  p_priority_window interval default null,
  p_signup_closes_before interval default interval '2 hours',
  p_cancellation_cutoff_before interval default interval '1 day',
  p_roster_publish_before interval default null,
  p_public_notes text default null,
  p_admin_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_timezone text;
  v_match_id uuid;
  v_arrival timestamptz;
  v_kickoff timestamptz;
  v_end timestamptz;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  if not public.is_league_admin(p_league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  select l.timezone into v_timezone
  from public.leagues l where l.id = p_league_id;

  -- A template from another league would let a caller pull one tenant's
  -- configuration into another.
  if p_template_id is not null and not exists (
    select 1 from public.match_templates t
    where t.id = p_template_id and t.league_id = p_league_id
  ) then
    raise exception 'MATCH_TEMPLATE_NOT_FOUND: no such template in this league'
      using errcode = 'P0001';
  end if;

  -- The one conversion that matters. `AT TIME ZONE` interprets the naive
  -- timestamp in the league's zone and yields the absolute instant, correctly
  -- across both daylight-saving transitions.
  v_arrival := (p_match_date + p_arrival_time) at time zone v_timezone;
  v_kickoff := (p_match_date + p_kickoff_time) at time zone v_timezone;
  v_end := (p_match_date + p_end_time) at time zone v_timezone;

  insert into public.matches (
    league_id, template_id, title, match_date, timezone,
    arrival_at, kickoff_at, end_at,
    location_name, location_map_url,
    capacity, min_players, selection_mode, waitlist_mode, team_count,
    priority_window,
    signup_closes_at, cancellation_cutoff_at, roster_publish_target_at,
    status, public_notes, created_by
  )
  values (
    p_league_id, p_template_id, btrim(p_title), p_match_date, v_timezone,
    v_arrival, v_kickoff, v_end,
    btrim(p_location_name), nullif(btrim(coalesce(p_location_map_url, '')), ''),
    p_capacity, p_min_players, p_selection_mode, p_waitlist_mode, p_team_count,
    p_priority_window,
    v_kickoff - p_signup_closes_before,
    v_kickoff - p_cancellation_cutoff_before,
    case when p_roster_publish_before is null then null
         else v_kickoff - p_roster_publish_before end,
    'draft', nullif(btrim(coalesce(p_public_notes, '')), ''), v_actor
  )
  returning id into v_match_id;

  if nullif(btrim(coalesce(p_admin_notes, '')), '') is not null then
    insert into public.match_admin_notes (match_id, league_id, notes, updated_by)
    values (v_match_id, p_league_id, btrim(p_admin_notes), v_actor);
  end if;

  perform public.log_audit_event(
    p_league_id, v_actor, 'match', v_match_id, 'match.created',
    null,
    jsonb_build_object('title', btrim(p_title), 'match_date', p_match_date,
                       'status', 'draft', 'capacity', p_capacity),
    null
  );

  return v_match_id;
end;
$$;


-- ── Publish ────────────────────────────────────────────────────────────────
--
-- Idempotent by state, not by luck: a match already open returns unchanged and
-- fans out nothing. That matters because publication is the event that creates
-- one notification per member, and a double-submitted form must not produce two.
--
-- Notification fanout is attached in 20260805030700, once the notifications
-- table exists. This migration establishes the transition and the audit event.
create or replace function public.publish_match(p_match_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_published_at timestamptz := now();
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  select * into v_match from public.matches m where m.id = p_match_id;

  -- A match in another tenant is reported exactly as one that does not exist.
  if not found or not public.is_league_admin(v_match.league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  if v_match.status = 'open' then
    return v_match.id;
  end if;

  if v_match.status <> 'draft' then
    raise exception 'MATCH_NOT_OPEN: only a draft match can be published'
      using errcode = 'P0001';
  end if;

  update public.matches
     set status = 'open',
         published_at = v_published_at,
         -- The priority window runs from publication, so this is the first
         -- moment it can be resolved. Never past the signup deadline.
         priority_window_ends_at = case
           when v_match.priority_window is null then null
           else least(v_published_at + v_match.priority_window, v_match.signup_closes_at)
         end
   where id = p_match_id;

  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match', p_match_id, 'match.published',
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'open', 'kickoff_at', v_match.kickoff_at),
    null
  );

  return v_match.id;
end;
$$;


-- ── Cancel ─────────────────────────────────────────────────────────────────
-- Retains the row. Cancelling is a state a match reaches, not a deletion.
create or replace function public.cancel_match(p_match_id uuid, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  select * into v_match from public.matches m where m.id = p_match_id;

  if not found or not public.is_league_admin(v_match.league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  -- Idempotent: the original cancellation timestamp and reason stand.
  if v_match.status = 'canceled' then
    return v_match.id;
  end if;

  update public.matches
     set status = 'canceled',
         canceled_at = now(),
         cancellation_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         -- Cancelling a draft keeps the constraint that anything past draft
         -- has been published; a draft that is abandoned counts as published
         -- at the moment it was cancelled.
         published_at = coalesce(v_match.published_at, now())
   where id = p_match_id;

  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match', p_match_id, 'match.canceled',
    jsonb_build_object('status', v_match.status),
    jsonb_build_object('status', 'canceled'),
    nullif(btrim(coalesce(p_reason, '')), '')
  );

  return v_match.id;
end;
$$;


-- ── Edit a published match ─────────────────────────────────────────────────
--
-- A deliberate, audited flow rather than a plain UPDATE, because changing a
-- published match changes the plans of everyone who has seen it. Each call
-- bumps `revision`, which is what lets the notification for *this* change be
-- distinct from the notification for the last one while a retry of the same
-- submission stays idempotent.
--
-- Drafts do not need this: nobody has seen them, so an administrator edits them
-- through the ordinary UPDATE policy.
create or replace function public.update_published_match(
  p_match_id uuid,
  p_title text,
  p_match_date date,
  p_arrival_time time,
  p_kickoff_time time,
  p_end_time time,
  p_location_name text,
  p_capacity integer,
  p_min_players integer,
  p_team_count integer,
  p_location_map_url text default null,
  p_public_notes text default null,
  p_change_note text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_timezone text;
  v_arrival timestamptz;
  v_kickoff timestamptz;
  v_end timestamptz;
  v_signup_lead interval;
  v_cancel_lead interval;
  v_roster_lead interval;
  v_revision integer;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  select * into v_match from public.matches m where m.id = p_match_id;

  if not found or not public.is_league_admin(v_match.league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  if v_match.status <> 'open' then
    raise exception 'MATCH_NOT_OPEN: only an open match can be edited this way'
      using errcode = 'P0001';
  end if;

  v_timezone := v_match.timezone;

  -- Deadlines were stored as instants, so preserve how far ahead of kickoff
  -- they sat rather than re-deriving them from defaults the administrator may
  -- have overridden.
  v_signup_lead := v_match.kickoff_at - v_match.signup_closes_at;
  v_cancel_lead := v_match.kickoff_at - v_match.cancellation_cutoff_at;
  v_roster_lead := case when v_match.roster_publish_target_at is null then null
                        else v_match.kickoff_at - v_match.roster_publish_target_at end;

  v_arrival := (p_match_date + p_arrival_time) at time zone v_timezone;
  v_kickoff := (p_match_date + p_kickoff_time) at time zone v_timezone;
  v_end := (p_match_date + p_end_time) at time zone v_timezone;

  update public.matches
     set title = btrim(p_title),
         match_date = p_match_date,
         arrival_at = v_arrival,
         kickoff_at = v_kickoff,
         end_at = v_end,
         location_name = btrim(p_location_name),
         location_map_url = nullif(btrim(coalesce(p_location_map_url, '')), ''),
         capacity = p_capacity,
         min_players = p_min_players,
         team_count = p_team_count,
         public_notes = nullif(btrim(coalesce(p_public_notes, '')), ''),
         signup_closes_at = v_kickoff - v_signup_lead,
         cancellation_cutoff_at = v_kickoff - v_cancel_lead,
         roster_publish_target_at = case when v_roster_lead is null then null
                                         else v_kickoff - v_roster_lead end,
         priority_window_ends_at = case
           when v_match.priority_window_ends_at is null then null
           else least(v_match.priority_window_ends_at, v_kickoff - v_signup_lead)
         end,
         revision = v_match.revision + 1
   where id = p_match_id
  returning revision into v_revision;

  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match', p_match_id, 'match.updated',
    jsonb_build_object('title', v_match.title, 'kickoff_at', v_match.kickoff_at,
                       'capacity', v_match.capacity, 'revision', v_match.revision),
    jsonb_build_object('title', btrim(p_title), 'kickoff_at', v_kickoff,
                       'capacity', p_capacity, 'revision', v_revision),
    nullif(btrim(coalesce(p_change_note, '')), '')
  );

  return v_revision;
end;
$$;

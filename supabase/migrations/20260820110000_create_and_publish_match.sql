-- MatchDay — pilot usability
-- Creating a match and opening it in one step.
--
-- ── THE PROBLEM ────────────────────────────────────────────────────────────
--
-- `create_match()` has always produced a draft, and `publish_match()` has
-- always been a separate trip: find the match again, open it, press Publish.
-- Organizers were creating a match, believing they had scheduled it, and
-- leaving it invisible to their league until somebody asked why no signup had
-- opened. The failure was silent, and it cost real matches.
--
-- ── WHY THIS IS A WRAPPER AND NOT A NEW PATH ───────────────────────────────
--
-- Publication is not "set status = open". It stamps `published_at`, derives
-- `priority_window_ends_at` from that stamp (never past the signup deadline),
-- writes the audit event, and fans out exactly one `match_published`
-- notification per active member. Every one of those rules lives in
-- `publish_match()`, and a second implementation would be a second lifecycle —
-- drifting from the first the moment either changed.
--
-- So this function calls the two existing functions and does nothing else. It
-- adds no authorization of its own, because it needs none: `create_match()`
-- refuses a caller who is not the league's administrator, and `publish_match()`
-- refuses one who is not the administrator of the league the new match belongs
-- to. Both still run, in that order, exactly as they do today.
--
-- ── ATOMICITY IS THE WHOLE POINT ───────────────────────────────────────────
--
-- A PL/pgSQL function body runs inside the caller's transaction, so the two
-- calls below either both commit or neither does. If publication fails — a
-- lifecycle guard, a constraint, a fanout error — the INSERT is rolled back
-- with it and no half-made draft is left behind for somebody to discover later
-- and wonder about. That is the property the UI's "Publish match" button
-- promises, and it is why this exists rather than the application making two
-- RPC calls in sequence.
--
-- SECURITY DEFINER with an empty `search_path`, matching every other domain
-- function in this schema: the callees are already definers, and a wrapper that
-- was not would change whose privileges resolve the unqualified names in its
-- own body.

create or replace function public.create_and_publish_match(
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
  v_match_id uuid;
begin
  -- Identical argument order to `create_match`, passed straight through. No
  -- defaulting, no coercion, no interpretation: whatever the application sends
  -- to one path it sends to the other, so a draft and a published match created
  -- from the same form are the same row in every column but `status`.
  v_match_id := public.create_match(
    p_league_id,
    p_title,
    p_match_date,
    p_arrival_time,
    p_kickoff_time,
    p_end_time,
    p_location_name,
    p_capacity,
    p_min_players,
    p_selection_mode,
    p_waitlist_mode,
    p_team_count,
    p_template_id,
    p_location_map_url,
    p_priority_window,
    p_signup_closes_before,
    p_cancellation_cutoff_before,
    p_roster_publish_before,
    p_public_notes,
    p_admin_notes
  );

  -- Defensive, and cheap. `create_match` returns the id of the row it inserted
  -- and cannot currently return null, but publishing `null` would raise
  -- something far less legible than this.
  if v_match_id is null then
    raise exception 'MATCH_NOT_FOUND: the match could not be created'
      using errcode = 'P0001';
  end if;

  -- The canonical transition, unchanged: authorization, the draft-only guard,
  -- `published_at`, the priority window, the audit event and one notification
  -- per active member all happen in here.
  perform public.publish_match(v_match_id);

  return v_match_id;
end;
$$;

comment on function public.create_and_publish_match(
  uuid, text, date, time, time, time, text, integer, integer,
  public.selection_mode, public.waitlist_mode, integer, uuid, text,
  interval, interval, interval, interval, text, text
) is
  'Creates a match and publishes it in one transaction by calling create_match() '
  'then publish_match(). Adds no rules of its own; if publication fails the '
  'creation rolls back with it.';


-- ── Execution ──────────────────────────────────────────────────────────────
--
-- A newly created function is EXECUTE-able by PUBLIC, which is exactly the hole
-- `20260805030900_revoke_public_function_execute.sql` closed for every function
-- that existed then — and `tests/db/schema.test.ts` asserts no function in
-- `public` grants EXECUTE to PUBLIC, so this is not optional. Revoked first,
-- then granted to the same two roles as `create_match` and `publish_match`.

revoke execute on function public.create_and_publish_match(
  uuid, text, date, time, time, time, text, integer, integer,
  public.selection_mode, public.waitlist_mode, integer, uuid, text,
  interval, interval, interval, interval, text, text
) from public;

grant execute on function public.create_and_publish_match(
  uuid, text, date, time, time, time, text, integer, integer,
  public.selection_mode, public.waitlist_mode, integer, uuid, text,
  interval, interval, interval, interval, text, text
) to authenticated, service_role;

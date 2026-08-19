-- MatchDay — league-level match timing defaults
--
-- ── THE PROBLEM ────────────────────────────────────────────────────────────
--
-- An organizer could set a league's capacity, minimum, team count and signup
-- modes once, in settings. The four *timing* rules were not there: signup
-- close, cancellation cutoff, priority window and roster-publish target lived
-- only on individual matches and on `match_templates`. Creating a match with
-- no template fell back to constants baked into the application — two hours
-- and one day — that nobody could change.
--
-- So "my league closes signup twelve hours before kickoff" was not something a
-- league could express. It had to be retyped on every match, or discovered via
-- the Templates page, which is a tool for *different kinds of match* rather
-- than for a league's ordinary policy. That is not self-service.
--
-- ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
--
--   * It does not touch a single existing match. A match stores resolved
--     instants (`signup_closes_at`, …), computed once at creation from the
--     league timezone. Changing a league default later cannot reach backwards
--     into one, which is the property that makes this safe to ship.
--   * It does not migrate `match_templates`. A template that already carries
--     its own values keeps them and still wins when selected.
--   * It adds no cross-field rules. Whether a cancellation cutoff may fall
--     after a signup close is a product question this migration does not
--     answer, and `publish_match`'s existing clamp on `priority_window_ends_at`
--     is untouched.

-- ── The columns ────────────────────────────────────────────────────────────
--
-- Two NOT NULL with defaults, two nullable — and the split is meaning, not
-- taste. Every match has a signup close and a cancellation cutoff, so there is
-- always an answer. A priority window and a roster-publish target are features
-- a league may simply not use, and `null` is how "not used" is spelled; a zero
-- would mean "a window of zero length", which is a different statement.
--
-- The defaults are what the application constants used to be, so every league
-- that already exists is backfilled to precisely today's behaviour and no
-- organizer has to configure anything for their league to keep working.

alter table public.leagues
  add column default_signup_closes_before interval not null default interval '2 hours',
  add column default_cancellation_cutoff_before interval not null default interval '1 day',
  add column default_priority_window interval,
  add column default_roster_publish_before interval;

comment on column public.leagues.default_signup_closes_before is
  'Starting value for a new match''s signup deadline, measured back from kickoff. '
  'Copied into the match at creation; changing it never moves an existing match.';
comment on column public.leagues.default_cancellation_cutoff_before is
  'Starting value for a new match''s cancellation cutoff, measured back from kickoff.';
comment on column public.leagues.default_priority_window is
  'Starting value for a new match''s priority window. NULL means the league does not use one.';
comment on column public.leagues.default_roster_publish_before is
  'Starting value for a new match''s roster-publish target. A planning target only — '
  'nothing in MatchDay publishes a roster automatically. NULL means unset.';

-- ── The bounds ─────────────────────────────────────────────────────────────
--
-- 720 hours is thirty days, matching `hoursSchema(…, 720)` in
-- `src/lib/validation/match.ts`. Until now that bound existed only in Zod, so a
-- direct RPC call could store a decade; the database is the authority and now
-- says so.
--
-- The nullable two are written as an explicit `is null or …` rather than
-- relying on a comparison against NULL evaluating to NULL and therefore
-- passing. Both forms accept NULL — but this repository has already shipped one
-- CHECK that was silently satisfied by a NULL nobody intended
-- (`array_length` on an empty array, fixed in 20260818090100), and a constraint
-- whose treatment of NULL you have to reason about is a constraint that will be
-- misread eventually.

alter table public.leagues
  add constraint leagues_default_signup_closes_before_range
    check (default_signup_closes_before >= interval '0'
       and default_signup_closes_before <= interval '720 hours'),
  add constraint leagues_default_cancellation_cutoff_before_range
    check (default_cancellation_cutoff_before >= interval '0'
       and default_cancellation_cutoff_before <= interval '720 hours'),
  add constraint leagues_default_priority_window_range
    check (default_priority_window is null
       or (default_priority_window >= interval '0'
       and default_priority_window <= interval '720 hours')),
  add constraint leagues_default_roster_publish_before_range
    check (default_roster_publish_before is null
       or (default_roster_publish_before >= interval '0'
       and default_roster_publish_before <= interval '720 hours'));


-- ── create_league ──────────────────────────────────────────────────────────
--
-- DROPPED AND RECREATED, NOT REPLACED. `CREATE OR REPLACE FUNCTION` with a
-- different number of parameters does not replace anything — it creates an
-- *overload*, and the fifteen-argument version would survive alongside the new
-- one. PostgREST would then have two candidates and the older, timing-unaware
-- function would still be reachable. The exact identity signature is named
-- below, and never `CASCADE`: nothing should be dropped as a side effect of
-- this, and if something did depend on it, silence is the wrong answer.
--
-- Everything else about the function is unchanged: the authorization, the
-- profile requirement, the forced `private` visibility, the single-statement
-- membership insert the deferred admin-cardinality trigger requires, the audit
-- event, and dropping the creator into their new league.

drop function if exists public.create_league(
  text, text, text, text, text, text, integer, integer,
  public.selection_mode, public.waitlist_mode, integer, text, text, boolean, boolean
);

create function public.create_league(
  p_name text,
  p_slug text,
  p_general_area text,
  p_timezone text,
  p_sport_label text,
  p_description text,
  p_default_capacity integer,
  p_default_min_players integer default 0,
  p_default_selection_mode public.selection_mode default 'first_come',
  p_default_waitlist_mode public.waitlist_mode default 'automatic',
  p_default_team_count integer default 2,
  p_default_location text default null,
  p_typical_schedule text default null,
  p_gender_field_enabled boolean default false,
  p_goalkeeper_field_enabled boolean default false,
  -- New, and last, so every existing call site keeps working untouched. The
  -- defaults repeat the column defaults so a caller that omits them gets the
  -- same league it would have got before this migration.
  p_default_signup_closes_before interval default interval '2 hours',
  p_default_cancellation_cutoff_before interval default interval '1 day',
  p_default_priority_window interval default null,
  p_default_roster_publish_before interval default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_league_id uuid;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  -- A league is owned by a person, so that person must have completed a
  -- profile. This also guarantees the created_by foreign key resolves.
  if not exists (select 1 from public.profiles p where p.id = v_actor) then
    raise exception 'PROFILE_INCOMPLETE: complete your profile before creating a league'
      using errcode = 'P0001';
  end if;

  insert into public.leagues (
    name, slug, general_area, timezone, sport_label, description,
    visibility,
    default_capacity, default_min_players,
    default_selection_mode, default_waitlist_mode, default_team_count,
    default_location, typical_schedule,
    gender_field_enabled, goalkeeper_field_enabled,
    default_signup_closes_before, default_cancellation_cutoff_before,
    default_priority_window, default_roster_publish_before,
    created_by
  )
  values (
    btrim(p_name), lower(btrim(p_slug)), btrim(p_general_area), p_timezone,
    btrim(p_sport_label), btrim(p_description),
    'private'::public.league_visibility,          -- always, regardless of input
    p_default_capacity, p_default_min_players,
    p_default_selection_mode, p_default_waitlist_mode, p_default_team_count,
    nullif(btrim(coalesce(p_default_location, '')), ''),
    nullif(btrim(coalesce(p_typical_schedule, '')), ''),
    p_gender_field_enabled, p_goalkeeper_field_enabled,
    -- `coalesce` on the two NOT NULL columns: an explicit null from a caller
    -- means "I did not choose", not "store nothing", and the column would
    -- reject it anyway with an error nobody could act on.
    coalesce(p_default_signup_closes_before, interval '2 hours'),
    coalesce(p_default_cancellation_cutoff_before, interval '1 day'),
    p_default_priority_window,
    p_default_roster_publish_before,
    v_actor
  )
  returning id into v_league_id;

  insert into public.league_memberships (league_id, user_id, role, status)
  values (v_league_id, v_actor, 'league_admin', 'active');

  perform public.log_audit_event(
    v_league_id, v_actor, 'league', v_league_id, 'league.created',
    null,
    jsonb_build_object('name', btrim(p_name), 'slug', lower(btrim(p_slug)),
                       'visibility', 'private'),
    null
  );

  -- Drop the creator straight into their new league.
  insert into public.user_app_state (user_id, active_league_id)
  values (v_actor, v_league_id)
  on conflict (user_id) do update set active_league_id = excluded.active_league_id;

  return v_league_id;
end;
$$;


-- ── Execution ──────────────────────────────────────────────────────────────
--
-- A recreated function comes back EXECUTE-able by PUBLIC, which is the hole
-- 20260805030900 closed for every function that existed then — and
-- `tests/db/schema.test.ts` asserts no function in `public` grants EXECUTE to
-- PUBLIC. Revoked first, then granted to exactly the two roles the previous
-- signature had.

revoke execute on function public.create_league(
  text, text, text, text, text, text, integer, integer,
  public.selection_mode, public.waitlist_mode, integer, text, text, boolean, boolean,
  interval, interval, interval, interval
) from public;

grant execute on function public.create_league(
  text, text, text, text, text, text, integer, integer,
  public.selection_mode, public.waitlist_mode, integer, text, text, boolean, boolean,
  interval, interval, interval, interval
) to authenticated, service_role;

-- Matchday — Phase 3B
-- Reusable match templates and concrete matches.
--
-- Two ideas kept deliberately apart. A *template* holds a league's recurring
-- intent — "Mondays, arrive 18:30, kick off 19:00, 22 players" — as local times
-- and relative rules. A *match* is one real occasion with every time already
-- resolved to an absolute instant.
--
-- Matches store concrete timestamptz values rather than re-deriving them from
-- the template at read time. Recurrence rules are ambiguous exactly where it
-- matters: across a daylight-saving transition "19:00 every Monday" is two
-- different instants, and a roster, a deadline and a reminder must all agree on
-- which one. Resolving once at creation makes that agreement permanent, and
-- means editing a template never silently moves a match somebody has already
-- signed up for.

-- All six states from 02 §3, not only the three Phase 3 implements. Adding a
-- value to an enum later is a schema change on a table that will by then hold
-- production rows; declaring them now costs nothing and lets Phase 4 and Phase 6
-- ship behaviour alone. The transition guard below is what actually restricts
-- Phase 3.
create type public.match_lifecycle_status as enum (
  'draft',
  'open',
  'roster_finalized',
  'teams_published',
  'canceled',
  'completed'
);


-- ── Templates ──────────────────────────────────────────────────────────────

create table public.match_templates (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete cascade,

  name text not null,

  -- 0 = Sunday … 6 = Saturday, matching PostgreSQL's `extract(dow ...)`.
  -- Free-text recurrence notes cover anything that is not a weekly cadence;
  -- neither is executed by Phase 3, which creates matches explicitly.
  day_of_week smallint,
  recurrence_note text,

  -- Local wall-clock times, resolved against the league timezone when a match
  -- is created from this template.
  arrival_time time not null,
  kickoff_time time not null,
  end_time time not null,

  location_name text not null,
  location_map_url text,

  capacity integer not null,
  min_players integer not null default 0,
  selection_mode public.selection_mode not null default 'first_come',
  waitlist_mode public.waitlist_mode not null default 'automatic',
  team_count integer not null default 2,

  -- Deadlines expressed relative to kickoff, so one template works for every
  -- occurrence regardless of date.
  priority_window interval,
  signup_closes_before interval not null default interval '2 hours',
  cancellation_cutoff_before interval not null default interval '1 day',
  roster_publish_before interval,

  -- Future-compatible reminder metadata. Phase 3 stores it and schedules
  -- nothing; the scheduler is Phase 5.
  reminder_offsets interval[] not null default '{}'::interval[],

  is_active boolean not null default true,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint match_templates_name_length
    check (char_length(btrim(name)) between 1 and 120),
  constraint match_templates_day_of_week_range
    check (day_of_week is null or day_of_week between 0 and 6),
  constraint match_templates_recurrence_note_length
    check (recurrence_note is null or char_length(btrim(recurrence_note)) between 1 and 160),
  constraint match_templates_location_length
    check (char_length(btrim(location_name)) between 1 and 160),
  constraint match_templates_map_url_scheme
    check (location_map_url is null
           or (location_map_url ~ '^https://' and char_length(location_map_url) <= 2048)),

  -- Mirrors the league-level rules so a template cannot describe a match the
  -- matches table would refuse.
  constraint match_templates_capacity_range check (capacity between 2 and 200),
  constraint match_templates_min_players_range
    check (min_players >= 0 and min_players <= capacity),
  constraint match_templates_team_count_range check (team_count between 2 and 20),

  constraint match_templates_kickoff_after_arrival check (kickoff_time >= arrival_time),
  constraint match_templates_end_after_kickoff check (end_time > kickoff_time),
  constraint match_templates_priority_window_positive
    check (priority_window is null or priority_window > interval '0'),
  constraint match_templates_signup_close_non_negative
    check (signup_closes_before >= interval '0'),
  constraint match_templates_cancellation_cutoff_non_negative
    check (cancellation_cutoff_before >= interval '0'),
  constraint match_templates_roster_publish_non_negative
    check (roster_publish_before is null or roster_publish_before >= interval '0')
);

create unique index match_templates_league_name_key
  on public.match_templates (league_id, lower(btrim(name)));

create index match_templates_league_active_idx
  on public.match_templates (league_id, name)
  where is_active;

alter table public.match_templates
  add constraint match_templates_id_league_key unique (id, league_id);

create trigger match_templates_set_updated_at
  before update on public.match_templates
  for each row execute function public.set_updated_at();


-- ── Matches ────────────────────────────────────────────────────────────────

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete cascade,

  -- Kept for provenance. A template may be deactivated or renamed without
  -- disturbing matches already created from it, so this is SET NULL rather
  -- than CASCADE.
  template_id uuid,

  title text not null,

  -- The local calendar date and the zone it was resolved against, retained
  -- alongside the absolute timestamps so a display can say "Monday 19:00" the
  -- same way the administrator entered it.
  match_date date not null,
  timezone text not null,

  arrival_at timestamptz not null,
  kickoff_at timestamptz not null,
  end_at timestamptz not null,

  location_name text not null,
  location_map_url text,

  capacity integer not null,
  min_players integer not null default 0,
  selection_mode public.selection_mode not null,
  waitlist_mode public.waitlist_mode not null,
  team_count integer not null default 2,

  -- The configured duration, plus the instant it resolves to. The window runs
  -- from publication, so the end is only knowable once the match is published;
  -- keeping the duration lets publish_match() compute it and lets an
  -- unpublished draft still describe its intent.
  priority_window interval,
  priority_window_ends_at timestamptz,
  signup_closes_at timestamptz not null,
  cancellation_cutoff_at timestamptz not null,
  roster_publish_target_at timestamptz,

  status public.match_lifecycle_status not null default 'draft',
  public_notes text,

  -- Administrator notes live in match_admin_notes, not here: members must be
  -- able to read this row, and Row Level Security filters rows rather than
  -- columns. Same reasoning as league_membership_admin_notes in Phase 1.

  -- Incremented by every audited edit of a published match. Notification
  -- idempotency keys include it, so a genuine change notifies again while a
  -- retry of the same change does not.
  revision integer not null default 0,

  created_by uuid references public.profiles (id) on delete set null,
  published_at timestamptz,
  canceled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint matches_template_fk
    foreign key (template_id, league_id)
    references public.match_templates (id, league_id) on delete set null,

  constraint matches_title_length check (char_length(btrim(title)) between 1 and 160),
  constraint matches_timezone_length check (char_length(btrim(timezone)) between 1 and 64),
  constraint matches_location_length
    check (char_length(btrim(location_name)) between 1 and 160),
  constraint matches_map_url_scheme
    check (location_map_url is null
           or (location_map_url ~ '^https://' and char_length(location_map_url) <= 2048)),
  constraint matches_public_notes_length
    check (public_notes is null or char_length(btrim(public_notes)) between 1 and 2000),
  constraint matches_cancellation_reason_length
    check (cancellation_reason is null
           or char_length(btrim(cancellation_reason)) between 1 and 500),

  constraint matches_capacity_range check (capacity between 2 and 200),
  constraint matches_min_players_range check (min_players >= 0 and min_players <= capacity),
  constraint matches_team_count_range check (team_count between 2 and 20),
  constraint matches_revision_non_negative check (revision >= 0),

  constraint matches_kickoff_after_arrival check (kickoff_at >= arrival_at),
  constraint matches_end_after_kickoff check (end_at > kickoff_at),
  constraint matches_signup_closes_by_kickoff check (signup_closes_at <= kickoff_at),
  constraint matches_cancellation_cutoff_by_kickoff check (cancellation_cutoff_at <= kickoff_at),
  constraint matches_roster_target_by_kickoff
    check (roster_publish_target_at is null or roster_publish_target_at <= kickoff_at),
  constraint matches_priority_window_positive
    check (priority_window is null or priority_window > interval '0'),
  constraint matches_priority_window_before_close
    check (priority_window_ends_at is null or priority_window_ends_at <= signup_closes_at),

  -- A match that is not a draft has been published, by definition. This is what
  -- makes `published_at is not null` a safe visibility predicate for members.
  constraint matches_published_unless_draft
    check (status = 'draft' or published_at is not null),
  constraint matches_canceled_has_timestamp
    check ((status = 'canceled') = (canceled_at is not null))
);

alter table public.matches
  add constraint matches_id_league_key unique (id, league_id);

-- The member-facing list: upcoming published matches for a league.
create index matches_league_kickoff_idx
  on public.matches (league_id, kickoff_at)
  where published_at is not null;

-- The administrator's own view, drafts included.
create index matches_league_status_idx
  on public.matches (league_id, status, kickoff_at desc);

create index matches_template_idx on public.matches (template_id);

create trigger matches_set_updated_at
  before update on public.matches
  for each row execute function public.set_updated_at();

-- Timezone validity is a database rule for matches exactly as it is for
-- leagues; a match inherits the league's zone but the column is its own.
create or replace function public.matches_validate_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from pg_catalog.pg_timezone_names tz where tz.name = new.timezone
  ) then
    raise exception 'INVALID_TIMEZONE: % is not a recognised IANA timezone', new.timezone
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger matches_validate_timezone
  before insert or update of timezone on public.matches
  for each row execute function public.matches_validate_timezone();

-- ── Lifecycle transition guard ─────────────────────────────────────────────
--
-- The enum names six states; Phase 3 implements three. Rather than leave the
-- unimplemented four reachable — a match could be set to 'completed' with no
-- roster, no attendance and no code that understands it — every transition is
-- allowlisted here. Later phases extend this function; the enum does not move.
create or replace function public.matches_guard_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  -- Phase 3 transitions. Phase 4 adds open → roster_finalized, Phase 6 adds
  -- roster_finalized → teams_published, Phase 7 adds → completed.
  if (old.status = 'draft' and new.status in ('open', 'canceled'))
     or (old.status = 'open' and new.status = 'canceled')
  then
    return new;
  end if;

  raise exception 'MATCH_TRANSITION_INVALID: cannot move a match from % to %',
    old.status, new.status
    using errcode = '23514';
end;
$$;

create trigger matches_guard_status_transition
  before update on public.matches
  for each row execute function public.matches_guard_status_transition();

comment on table public.matches is
  'One concrete match. All times are absolute instants resolved once from the '
  'league timezone at creation, never re-derived from a recurrence rule. '
  'Administrator notes live in match_admin_notes so members can read this row.';


-- ── Administrator notes ────────────────────────────────────────────────────
-- Split out for the same reason as league_membership_admin_notes: active
-- members must read the match, and a policy cannot hide one column of a
-- readable row.

create table public.match_admin_notes (
  match_id uuid primary key,
  league_id uuid not null references public.leagues (id) on delete cascade,
  notes text not null,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint match_admin_notes_notes_length
    check (char_length(btrim(notes)) between 1 and 4000),

  constraint match_admin_notes_match_fk
    foreign key (match_id, league_id)
    references public.matches (id, league_id) on delete cascade
);

create index match_admin_notes_league_idx on public.match_admin_notes (league_id);

create trigger match_admin_notes_set_updated_at
  before update on public.match_admin_notes
  for each row execute function public.set_updated_at();

comment on table public.match_admin_notes is
  'Administrator-only notes about a match, held off the match row so that a '
  'member reading the match cannot read them.';

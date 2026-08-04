-- Matchday — Phase 1
-- Leagues: the tenant root. Every tenant-owned row in the system carries a
-- `league_id` that resolves here (PRD §12 "Security requirements").
--
-- Phase 1 creates the table, its constraints and its RLS. League creation UI,
-- invitations, join requests and public search are Phase 2 and are deliberately
-- absent — there is no INSERT policy for `authenticated`.

create table public.leagues (
  id uuid primary key default gen_random_uuid(),

  -- Required league fields (F-02).
  name text not null,
  slug text not null,
  general_area text not null,
  timezone text not null,
  sport_label text not null,
  description text not null,
  visibility public.league_visibility not null default 'private',
  default_capacity integer not null,
  default_min_players integer not null default 0,
  default_selection_mode public.selection_mode not null default 'first_come',
  default_waitlist_mode public.waitlist_mode not null default 'automatic',

  -- Optional league fields (F-02).
  default_team_count integer not null default 2,
  default_location text,
  typical_schedule text,
  logo_url text,
  position_labels text[] not null default '{}'::text[],
  gender_field_enabled boolean not null default false,
  goalkeeper_field_enabled boolean not null default false,
  public_contact text,

  -- Reserved for league-specific configuration that does not warrant a column
  -- yet (RMVFC priority-window rules, etc.). Must be a JSON object.
  settings_json jsonb not null default '{}'::jsonb,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint leagues_name_length
    check (char_length(btrim(name)) between 2 and 120),
  constraint leagues_slug_format
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 60),
  constraint leagues_general_area_length
    check (char_length(btrim(general_area)) between 1 and 120),
  constraint leagues_timezone_length
    check (char_length(btrim(timezone)) between 1 and 64),
  constraint leagues_sport_label_length
    check (char_length(btrim(sport_label)) between 1 and 60),
  constraint leagues_description_length
    check (char_length(btrim(description)) between 1 and 280),

  -- Capacity is configurable per league — never hard-coded to 22 or to 11v11
  -- (PRD §2). RMVFC seeds 22; the 5v5 league seeds 10.
  constraint leagues_default_capacity_range
    check (default_capacity between 2 and 200),
  constraint leagues_default_min_players_range
    check (default_min_players >= 0 and default_min_players <= default_capacity),
  constraint leagues_default_team_count_range
    check (default_team_count between 2 and 20),

  constraint leagues_settings_json_is_object
    check (jsonb_typeof(settings_json) = 'object'),

  constraint leagues_position_labels_valid check (
    array_length(position_labels, 1) is null
    or (
      array_ndims(position_labels) = 1
      and array_length(position_labels, 1) <= 20
      and array_position(position_labels, null::text) is null
      and public.text_array_entries_are_valid(position_labels, 1, 40)
    )
  ),

  constraint leagues_logo_url_scheme check (
    logo_url is null
    or (logo_url ~ '^https://' and char_length(logo_url) <= 2048)
  ),
  constraint leagues_typical_schedule_length
    check (typical_schedule is null or char_length(btrim(typical_schedule)) between 1 and 160),
  constraint leagues_default_location_length
    check (default_location is null or char_length(btrim(default_location)) between 1 and 160),
  constraint leagues_public_contact_length
    check (public_contact is null or char_length(btrim(public_contact)) between 1 and 160)
);

create unique index leagues_slug_key on public.leagues (slug);

-- Supports the Phase 2 public-search projection without scanning private rows.
create index leagues_searchable_idx
  on public.leagues (id)
  where visibility = 'searchable'::public.league_visibility;

create index leagues_created_by_idx on public.leagues (created_by);

create trigger leagues_validate_timezone
  before insert or update of timezone on public.leagues
  for each row execute function public.leagues_validate_timezone();

create trigger leagues_set_updated_at
  before update on public.leagues
  for each row execute function public.set_updated_at();

comment on table public.leagues is
  'Tenant root. New leagues default to private (PRD §6). The full row is only '
  'readable by non-removed members; Phase 2 public search will use a restricted '
  'projection view rather than widening this table''s RLS.';

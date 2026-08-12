-- Matchday — Phase 6B/6C
-- Teams, their draft assignments, and the published snapshot players see.
--
-- THE CENTRAL DECISION IS THE SPLIT BETWEEN DRAFT AND PUBLISHED.
--
-- `match_teams` and `match_team_assignments` are the administrator's working
-- copy. They are administrator-only and change freely — a rename, a move, a
-- randomize — without any of it reaching a player.
--
-- What players see is the most recent row in `match_team_publications` and its
-- entries. Publishing writes a new snapshot; nothing mutates in place. Three
-- properties follow from that shape rather than from any code being careful:
--
--   * "players see revision N while the administrator edits N+1" is automatic,
--     because the two live in different rows;
--   * a failed publication cannot leave half the old teams and half the new
--     ones visible, because a snapshot is one INSERT ... SELECT inside one
--     transaction;
--   * the published names are captured as text, so renaming a draft team after
--     publication does not silently rewrite what was announced.


-- ── Draft teams ────────────────────────────────────────────────────────────

create table public.match_teams (
  id uuid primary key default gen_random_uuid(),

  league_id uuid not null references public.leagues (id) on delete cascade,
  match_id uuid not null,

  name text not null,
  /** Shirt or colour, shown to players once published. */
  label text,

  /** 1-based. Determines the order teams are listed, for admin and player alike. */
  display_order integer not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint match_teams_name_length check (char_length(btrim(name)) between 1 and 60),
  constraint match_teams_label_length
    check (label is null or char_length(btrim(label)) between 1 and 40),
  constraint match_teams_display_order_positive check (display_order >= 1),

  -- A team belongs to exactly one match, and to that match's league. Both keys
  -- carry league_id, so a team in one tenant cannot be attached to a match in
  -- another.
  constraint match_teams_match_fk
    foreign key (match_id, league_id)
    references public.matches (id, league_id) on delete cascade,

  -- Two teams cannot occupy the same slot in the ordering.
  constraint match_teams_order_key unique (match_id, display_order)
    deferrable initially immediate
);

-- Assignments reference `(team_id, match_id)`, which needs its own key.
alter table public.match_teams
  add constraint match_teams_id_match_key unique (id, match_id);

create index match_teams_match_idx on public.match_teams (match_id, display_order);
create index match_teams_league_idx on public.match_teams (league_id);

create trigger match_teams_set_updated_at
  before update on public.match_teams
  for each row execute function public.set_updated_at();

comment on table public.match_teams is
  'An administrator''s draft teams for one match. Never visible to players — '
  'what they see is the latest match_team_publications snapshot.';


-- ── Draft assignments ──────────────────────────────────────────────────────

create table public.match_team_assignments (
  id uuid primary key default gen_random_uuid(),

  league_id uuid not null references public.leagues (id) on delete cascade,
  match_id uuid not null,
  team_id uuid not null,
  membership_id uuid not null,

  assigned_by uuid references public.profiles (id) on delete set null,
  assigned_at timestamptz not null default now(),

  -- ONE TEAM PER PLAYER PER MATCH, enforced here rather than in the functions
  -- that write it. A function can be bypassed by the next function somebody
  -- writes; a unique constraint cannot.
  constraint match_team_assignments_match_membership_key unique (match_id, membership_id),

  -- The team must belong to this match...
  constraint match_team_assignments_team_fk
    foreign key (team_id, match_id)
    references public.match_teams (id, match_id) on delete cascade,
  -- ...the match to this league...
  constraint match_team_assignments_match_fk
    foreign key (match_id, league_id)
    references public.matches (id, league_id) on delete cascade,
  -- ...and the member to the same league. Together these make a cross-league or
  -- cross-match assignment unrepresentable rather than merely rejected.
  constraint match_team_assignments_membership_fk
    foreign key (membership_id, league_id)
    references public.league_memberships (id, league_id) on delete cascade
);

create index match_team_assignments_team_idx on public.match_team_assignments (team_id);
create index match_team_assignments_match_idx on public.match_team_assignments (match_id);
create index match_team_assignments_league_idx on public.match_team_assignments (league_id);

comment on table public.match_team_assignments is
  'Draft team membership. Only a confirmed player may be assigned; the writing '
  'functions check that under the match row lock, and cancel_spot() removes the '
  'assignment when somebody stops being confirmed.';


-- ── Published snapshots ────────────────────────────────────────────────────
--
-- One row per publication, holding the teams exactly as they were announced.

create table public.match_team_publications (
  id uuid primary key default gen_random_uuid(),

  league_id uuid not null references public.leagues (id) on delete cascade,
  match_id uuid not null,

  /** 1 for the first publication, incrementing thereafter. */
  revision integer not null,

  published_at timestamptz not null default now(),
  published_by uuid references public.profiles (id) on delete set null,

  constraint match_team_publications_revision_positive check (revision >= 1),
  constraint match_team_publications_match_revision_key unique (match_id, revision),

  constraint match_team_publications_match_fk
    foreign key (match_id, league_id)
    references public.matches (id, league_id) on delete cascade
);

alter table public.match_team_publications
  add constraint match_team_publications_id_match_key unique (id, match_id);

create index match_team_publications_match_idx
  on public.match_team_publications (match_id, revision desc);

-- The team names and labels are stored as text rather than as a reference to
-- `match_teams`, deliberately. Renaming or deleting a draft team afterwards
-- must not rewrite or erase what was already announced.
create table public.match_team_publication_entries (
  id uuid primary key default gen_random_uuid(),

  publication_id uuid not null,
  league_id uuid not null references public.leagues (id) on delete cascade,
  match_id uuid not null,
  membership_id uuid not null,

  team_name text not null,
  team_label text,
  display_order integer not null,

  constraint match_team_publication_entries_publication_membership_key
    unique (publication_id, membership_id),

  constraint match_team_publication_entries_publication_fk
    foreign key (publication_id, match_id)
    references public.match_team_publications (id, match_id) on delete cascade,
  constraint match_team_publication_entries_membership_fk
    foreign key (membership_id, league_id)
    references public.league_memberships (id, league_id) on delete cascade
);

create index match_team_publication_entries_publication_idx
  on public.match_team_publication_entries (publication_id, display_order);

comment on table public.match_team_publications is
  'One published set of teams. Players read the highest revision for a match; '
  'republishing inserts a new row rather than mutating this one, so a partly '
  'applied publication cannot be observed.';


-- ── Publication metadata on the match ──────────────────────────────────────
--
-- `team_revision` is the counter 02 §17 names alongside the roster revision,
-- and is deliberately distinct from `roster_revision`: publishing teams says
-- nothing about the roster, and a shared counter would make one event suppress
-- the other's notification key.
--
-- NOTE ON `matches.status`. The lifecycle enum declares `teams_published`, and
-- the Phase 4 guard left it for this phase. It stays unreachable, on purpose:
--
--   * `match_signup_eligibility()` requires `status = 'open'`, so moving a
--     first-come match into `teams_published` would silently close its signup —
--     a Phase 4 behaviour change nobody asked for;
--   * `finalize_roster()` accepts only `open` and `roster_finalized`, so a match
--     parked in `teams_published` could no longer re-finalize its roster, which
--     is exactly the Phase 5 cancellation-then-republish path.
--
-- So publication is metadata, as `roster_finalized_at` already is for the
-- roster, and both selection modes behave identically. Player visibility keys
-- off `teams_published_at`, never off the lifecycle status.
alter table public.matches
  add column team_revision integer not null default 0,
  add column teams_published_at timestamptz;

alter table public.matches
  add constraint matches_team_revision_non_negative check (team_revision >= 0);

comment on column public.matches.team_revision is
  'Published team revisions. 0 means teams have never been published. Distinct '
  'from roster_revision: publishing teams never advances that, and vice versa.';

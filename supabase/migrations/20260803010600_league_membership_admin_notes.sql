-- Matchday — Phase 1
-- Administrator-only notes about a league membership.
--
-- WHY A SEPARATE TABLE (a resolved conflict between two product documents):
-- 02 §17 sketches `eligibility_notes` as a column on `league_memberships`, but
-- 02 §16 and PRD §12 require that administrator context and disciplinary
-- information never reach the player it concerns or their co-members — while
-- the league switcher requires each player to read their own membership row.
-- PostgreSQL row-level security cannot hide a single column from a readable
-- row, so keeping the notes on that row would leak them. They live here
-- instead, behind an administrator-only policy.
--
-- Phase 1 ships the table and its RLS only. There is no notes UI until Phase 2.

create table public.league_membership_admin_notes (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete cascade,
  membership_id uuid not null,

  note text not null,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint league_membership_admin_notes_note_length
    check (char_length(btrim(note)) between 1 and 2000),

  -- Composite foreign key: a note's league_id must match the league of the
  -- membership it annotates. This makes cross-tenant mislabelling structurally
  -- impossible rather than merely unlikely.
  constraint league_membership_admin_notes_membership_fk
    foreign key (membership_id, league_id)
    references public.league_memberships (id, league_id)
    on delete cascade
);

create index league_membership_admin_notes_membership_idx
  on public.league_membership_admin_notes (membership_id, created_at desc);

create index league_membership_admin_notes_league_idx
  on public.league_membership_admin_notes (league_id, created_at desc);

create trigger league_membership_admin_notes_set_updated_at
  before update on public.league_membership_admin_notes
  for each row execute function public.set_updated_at();

comment on table public.league_membership_admin_notes is
  'Administrator-only membership notes, held off league_memberships so that a '
  'player reading their own membership row cannot read notes about themselves.';

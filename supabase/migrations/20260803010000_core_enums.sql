-- Matchday — Phase 1
-- Core domain enumerations.
--
-- Values mirror docs/product/02_FEATURE_SPECIFICATIONS.md §3 exactly. Enums are
-- used (rather than free text plus a CHECK) so that an invalid state is
-- impossible to represent, not merely rejected.
--
-- Forward-only: never edit an applied migration; add a new one.

create type public.league_visibility as enum (
  'private',
  'searchable'
);

create type public.league_role as enum (
  'league_admin',
  'player'
);

create type public.membership_status as enum (
  'pending',
  'active',
  'suspended',
  'removed'
);

-- Selection and waitlist modes are league-level *defaults* in Phase 1. The
-- matches that consume them arrive in Phase 3/4; the enums live here so the
-- leagues table can be complete and no later migration has to rewrite it.
create type public.selection_mode as enum (
  'first_come',
  'admin_approval'
);

create type public.waitlist_mode as enum (
  'automatic',
  'admin_controlled'
);

comment on type public.league_role is
  'MVP league roles. Exactly one active league_admin per league is enforced by '
  'league_memberships_single_active_admin_key plus the deferred constraint '
  'trigger enforce_single_active_league_admin().';

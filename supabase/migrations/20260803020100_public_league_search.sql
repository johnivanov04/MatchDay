-- Matchday — Phase 2
-- The public league-search projection.
--
-- PRD §12 fixes exactly what a public or search result may contain:
--   league name, general area, sport/format label, typical schedule,
--   short description, and a request-to-join action.
-- and forbids member lists, rosters, profile fields, attendance and exact
-- private locations.
--
-- This view is that list, made literal. It is the ONLY object `anon` may read
-- anywhere in the database.
--
-- WHY A VIEW RATHER THAN A POLICY ON `leagues`:
-- Adding a `visibility = 'searchable'` policy to the base table would expose
-- *every column* of a searchable league — settings_json, default_location, the
-- creator's id — to anyone who asked. Row Level Security filters rows, never
-- columns. A view is the only way to publish a column subset, so the base
-- table's member-only policy from Phase 1 is left exactly as it was.
--
-- The view is SECURITY DEFINER (PostgreSQL's default) and therefore reads
-- `leagues` as its owner, bypassing that member-only policy on purpose. That
-- makes the WHERE clause below the entire security boundary for public
-- discovery, so it is asserted from four angles in tests/db/public-search.test.ts:
-- anonymous, authenticated non-member, member of a different league, and
-- column-by-column.
--
-- Fail-closed note: if this migration is ever applied by a role without
-- BYPASSRLS, the view returns zero rows rather than leaking — the safe direction.

create view public.searchable_leagues_public
with (security_invoker = false)
as
select
  l.id,
  l.slug,
  l.name,
  l.general_area,
  l.sport_label,
  l.typical_schedule,
  l.description
from public.leagues l
where l.visibility = 'searchable'::public.league_visibility;

comment on view public.searchable_leagues_public is
  'Public projection of searchable leagues: id, slug, name, general_area, '
  'sport_label, typical_schedule, description — and nothing else. Private '
  'leagues are excluded by the WHERE clause. Deliberately excludes '
  'default_location (PRD §12 forbids exposing exact private locations), '
  'settings_json, capacity/threshold/mode defaults, logo_url, public_contact '
  'and created_by. Never add a column here without re-reading PRD §12.';

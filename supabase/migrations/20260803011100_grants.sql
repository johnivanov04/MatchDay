-- Matchday — Phase 1
-- Table and function privileges.
--
-- RLS decides *which rows* a role may touch; GRANT decides *whether the role
-- may attempt the verb at all*. Both are needed: a missing DELETE policy and a
-- missing DELETE grant fail differently, and defence in depth means having
-- both.
--
-- Hosted Supabase ships `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL
-- ON TABLES TO anon, authenticated, service_role`, so tables created by a
-- migration are broadly granted unless something takes it back. This migration
-- takes it back explicitly and re-grants only what Phase 1 uses, which also
-- makes local, CI and hosted environments behave identically.

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

-- New tables added by future migrations start with no privileges, so a
-- forgotten GRANT fails loudly instead of silently exposing a table.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- ── anon ───────────────────────────────────────────────────────────────────
-- Unauthenticated callers get nothing in Phase 1. Public league search (Phase
-- 2) will grant SELECT on a dedicated projection view, never on a base table.

-- ── authenticated ──────────────────────────────────────────────────────────
grant select, insert, update on public.profiles                      to authenticated;
grant select, update         on public.leagues                       to authenticated;
grant select, update         on public.league_memberships            to authenticated;
grant select, insert, update, delete on public.league_membership_admin_notes to authenticated;
grant select                 on public.audit_events                  to authenticated;
grant select, insert, update, delete on public.user_app_state        to authenticated;

-- RLS policies are evaluated with the caller's privileges, so the helper
-- functions they call must be executable by `authenticated`.
grant execute on function public.is_league_member(uuid)          to authenticated, service_role;
grant execute on function public.is_active_member(uuid)          to authenticated, service_role;
grant execute on function public.is_league_admin(uuid)           to authenticated, service_role;
grant execute on function public.administers_league_of_user(uuid) to authenticated, service_role;

grant execute on function public.record_audit_event(uuid, text, uuid, text, jsonb, jsonb, text)
  to authenticated, service_role;

-- Pure predicate used inside CHECK constraints; evaluated as the writing role.
grant execute on function public.text_array_entries_are_valid(text[], integer, integer)
  to anon, authenticated, service_role;

-- ── service_role ───────────────────────────────────────────────────────────
-- The service role bypasses RLS by design and is used only from server-side
-- code that has already performed its own authorization. It is never sent to
-- the browser (see src/lib/supabase/admin.ts and the ESLint import guard).
grant select, insert, update, delete on all tables in schema public to service_role;

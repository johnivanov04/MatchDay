-- Matchday — Phase 2
-- Make "deny by default" actually true for functions.
--
-- THE DEFECT
-- PostgreSQL grants EXECUTE on every new function to the pseudo-role PUBLIC.
-- `REVOKE ... FROM anon, authenticated` does not remove that, because those
-- roles are not the grantee — PUBLIC is, and every role inherits it. The
-- revokes in 20260803011100 and 20260803020400 therefore had no effect, and
-- every function in `public` was callable by any role that could reach the
-- database.
--
-- For most of them that is harmless: each performs its own authorization from
-- `auth.uid()` and refuses a caller who is not entitled. But
-- `public.log_audit_event()` is deliberately the *unchecked* writer — the one
-- the SECURITY DEFINER functions use to record an event whose actor is not an
-- administrator, such as a player redeeming an invitation. Callable by anyone,
-- it let any signed-in user forge or flood an audit trail in any league,
-- including leagues they have no relationship with. That is exactly the
-- tamper-evidence that PRD §12 and 02 §19 rely on.
--
-- THE FIX
-- Revoke EXECUTE from PUBLIC across the schema, then re-grant, by name, only
-- what a non-owner role must be able to call. From here a new function is
-- unreachable until someone grants it deliberately — a forgotten grant becomes
-- a loud failure instead of a silent exposure.
--
-- Trigger functions need no grant: PostgreSQL checks EXECUTE when the trigger
-- is created, not when it fires. Functions used inside CHECK constraints DO
-- need one, because those are evaluated as the writing role.

revoke execute on all functions in schema public from public;

-- ── Evaluated inside CHECK constraints, as the writing role ────────────────
grant execute on function public.text_array_entries_are_valid(text[], integer, integer)
  to anon, authenticated, service_role;

-- ── Called from RLS policies, as the querying role ────────────────────────
grant execute on function public.is_league_member(uuid)           to authenticated, service_role;
grant execute on function public.is_active_member(uuid)           to authenticated, service_role;
grant execute on function public.is_league_admin(uuid)            to authenticated, service_role;
grant execute on function public.administers_league_of_user(uuid) to authenticated, service_role;

-- ── Operations. Each authorizes its own caller from auth.uid(). ───────────
grant execute on function public.record_audit_event(uuid, text, uuid, text, jsonb, jsonb, text)
  to authenticated, service_role;

grant execute on function public.create_league(
  text, text, text, text, text, text, integer, integer,
  public.selection_mode, public.waitlist_mode, integer, text, text, boolean, boolean
) to authenticated, service_role;

grant execute on function public.request_to_join_league(uuid, text)       to authenticated, service_role;
grant execute on function public.withdraw_join_request(uuid)              to authenticated, service_role;
grant execute on function public.decide_join_request(uuid, boolean, text) to authenticated, service_role;

grant execute on function public.create_league_invite(
  uuid, text, text, public.membership_status, integer, integer
) to authenticated, service_role;
grant execute on function public.revoke_league_invite(uuid)               to authenticated, service_role;
grant execute on function public.redeem_league_invite(text)               to authenticated, service_role;

grant execute on function public.add_league_member_by_email(
  uuid, text, public.membership_status
) to authenticated, service_role;

grant execute on function public.transfer_league_administration(uuid, uuid, text)
  to authenticated, service_role;

-- ── Deliberately NOT granted to anyone ────────────────────────────────────
-- public.log_audit_event(...)      — the unchecked audit writer.
-- public.jsonb_changed_keys(...)   — internal to the audit triggers.
-- every trigger function            — fires as the table owner.
--
-- These remain callable only by the object owner, which is what the SECURITY
-- DEFINER functions above execute as.

-- Future functions inherit the same posture rather than relying on a reviewer
-- noticing. (This affects objects created by the role running migrations.)
alter default privileges in schema public revoke execute on functions from public;

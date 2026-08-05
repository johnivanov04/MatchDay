-- Matchday — Phase 2
-- Row Level Security and privileges for the new objects.
--
-- Phase 1 set `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES
-- FROM anon, authenticated`, so both tables created in 20260803020000 currently
-- have NO privileges for either role. Everything below is additive; no Phase 1
-- policy or grant is modified or dropped.

alter table public.league_join_requests enable row level security;
alter table public.league_invites       enable row level security;

alter table public.league_join_requests force row level security;
alter table public.league_invites       force row level security;


-- ── league_join_requests ───────────────────────────────────────────────────
-- Read: your own requests, wherever they are, plus every request in a league
-- you administer. A member of the league who is not the administrator sees
-- nothing — the queue is administrator business.
--
-- No INSERT/UPDATE/DELETE policy and no write grant: requests are created by
-- request_to_join_league(), decided by decide_join_request(), and withdrawn by
-- withdraw_join_request(). A client cannot manufacture an approved request.

create policy league_join_requests_select_self
  on public.league_join_requests
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy league_join_requests_select_admin
  on public.league_join_requests
  for select
  to authenticated
  using (public.is_league_admin(league_id));


-- ── league_invites ─────────────────────────────────────────────────────────
-- Administrator-only, in every direction. Invitees never read this table: they
-- present a token to redeem_league_invite(), which resolves it as the function
-- owner.

create policy league_invites_select_admin
  on public.league_invites
  for select
  to authenticated
  using (public.is_league_admin(league_id));


-- ── Grants ─────────────────────────────────────────────────────────────────

grant select on public.league_join_requests to authenticated;

-- COLUMN-LEVEL grant, deliberately. `token_hash` is omitted, so even the
-- league's own administrator cannot read the digest back through PostgREST —
-- `select *` on this table fails for `authenticated`. Combined with the
-- database-side hashing in create_league_invite(), that means no API caller can
-- obtain either the token or anything derived from it after creation.
grant select (
  id, league_id, label, grants_status, max_uses, use_count,
  expires_at, revoked_at, created_by, created_at, updated_at
) on public.league_invites to authenticated;

-- The public projection. This is the only object `anon` may read anywhere in
-- the database; the `leagues` base table remains member-only.
grant select on public.searchable_leagues_public to anon, authenticated;

-- Operations. Each derives its actor from auth.uid() and performs its own
-- authorization check; see 20260803020200.
grant execute on function public.create_league(
  text, text, text, text, text, text, integer, integer,
  public.selection_mode, public.waitlist_mode, integer, text, text, boolean, boolean
) to authenticated;

grant execute on function public.request_to_join_league(uuid, text)      to authenticated;
grant execute on function public.withdraw_join_request(uuid)             to authenticated;
grant execute on function public.decide_join_request(uuid, boolean, text) to authenticated;

grant execute on function public.create_league_invite(
  uuid, text, text, public.membership_status, integer, integer
) to authenticated;
grant execute on function public.revoke_league_invite(uuid)              to authenticated;
grant execute on function public.redeem_league_invite(text)              to authenticated;

grant execute on function public.add_league_member_by_email(
  uuid, text, public.membership_status
) to authenticated;

grant execute on function public.transfer_league_administration(uuid, uuid, text)
  to authenticated;

-- INTERNAL ONLY. log_audit_event() performs no authorization of its own — it is
-- the unchecked writer used by the SECURITY DEFINER functions above, which run
-- as the owner and therefore may call it. Granting it to `authenticated` would
-- let any signed-in user forge an audit trail in any league.
revoke all on function public.log_audit_event(uuid, uuid, text, uuid, text, jsonb, jsonb, text)
  from anon, authenticated;

-- Used inside the audit triggers, which are SECURITY DEFINER; no client needs it.
revoke all on function public.jsonb_changed_keys(jsonb, jsonb, text)
  from anon, authenticated;

-- The service role keeps blanket table access (it bypasses RLS by design and is
-- only ever used from server-side code that has already authorized the actor).
grant select, insert, update, delete on public.league_join_requests to service_role;
grant select, insert, update, delete on public.league_invites       to service_role;
grant select on public.searchable_leagues_public                    to service_role;

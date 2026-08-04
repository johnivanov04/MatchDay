-- Matchday — Phase 1
-- Tenant-aware Row Level Security.
--
-- PRD §12: "Server authorization and database Row Level Security both enforce
-- tenancy. UI hiding is never treated as authorization."
--
-- Posture: deny by default. RLS is ENABLED and FORCED on every table in
-- `public`; a table with no matching policy returns zero rows and rejects every
-- write. `anon` receives no policies at all — an unauthenticated caller sees
-- nothing, including searchable leagues (public search is Phase 2 and will use
-- a restricted projection rather than widening these policies).
--
-- `(select auth.uid())` rather than a bare `auth.uid()` is the Supabase
-- idiom: the planner caches it as an InitPlan instead of re-evaluating per row.

alter table public.profiles                      enable row level security;
alter table public.leagues                       enable row level security;
alter table public.league_memberships            enable row level security;
alter table public.league_membership_admin_notes enable row level security;
alter table public.audit_events                  enable row level security;
alter table public.user_app_state                enable row level security;

alter table public.profiles                      force row level security;
alter table public.leagues                       force row level security;
alter table public.league_memberships            force row level security;
alter table public.league_membership_admin_notes force row level security;
alter table public.audit_events                  force row level security;
alter table public.user_app_state                force row level security;


-- ── profiles ───────────────────────────────────────────────────────────────
-- Own profile, always. Plus: an active league administrator may read the
-- profiles of their own league's members (02 §20) — needed to manage
-- membership and, later, to assign teams.
--
-- Co-players may NOT read each other's profiles in Phase 1. Rosters (Phase 4)
-- will expose names through a restricted projection, so that phone, gender and
-- goalkeeper willingness never travel with them (PRD §12).

create policy profiles_select_self
  on public.profiles
  for select
  to authenticated
  using (id = (select auth.uid()));

create policy profiles_select_league_admin
  on public.profiles
  for select
  to authenticated
  using (public.administers_league_of_user(id));

create policy profiles_insert_self
  on public.profiles
  for insert
  to authenticated
  with check (id = (select auth.uid()));

create policy profiles_update_self
  on public.profiles
  for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No DELETE policy: profiles disappear only when the auth user is deleted.


-- ── leagues ────────────────────────────────────────────────────────────────
-- Readable by anyone holding a non-removed membership. A pending or suspended
-- member can still see which league they are waiting on or suspended from,
-- which the switcher needs; a removed member sees nothing.
--
-- No INSERT policy: league creation is Phase 2 and will run through a
-- transactional function that also creates the administrator membership.
-- No DELETE policy: leagues are never destroyed from the application.

create policy leagues_select_member
  on public.leagues
  for select
  to authenticated
  using (public.is_league_member(id));

create policy leagues_update_admin
  on public.leagues
  for update
  to authenticated
  using (public.is_league_admin(id))
  with check (public.is_league_admin(id));


-- ── league_memberships ─────────────────────────────────────────────────────
-- Own memberships (across every league — this is what makes the switcher work
-- without leaking anything), plus every membership of a league you administer.
--
-- No INSERT policy: joining is Phase 2 (invitations and join requests).
-- No DELETE policy: removal sets status = 'removed' so history survives.

create policy league_memberships_select_self
  on public.league_memberships
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy league_memberships_select_admin
  on public.league_memberships
  for select
  to authenticated
  using (public.is_league_admin(league_id));

-- USING pins the row's current league, WITH CHECK pins its post-update league,
-- so an administrator cannot write a row into a league they do not administer.
-- league_id and user_id are additionally immutable at the trigger level.
create policy league_memberships_update_admin
  on public.league_memberships
  for update
  to authenticated
  using (public.is_league_admin(league_id))
  with check (public.is_league_admin(league_id));


-- ── league_membership_admin_notes ──────────────────────────────────────────
-- Administrator-only in every direction. The member the note is about has no
-- read path to it.

create policy league_membership_admin_notes_select_admin
  on public.league_membership_admin_notes
  for select
  to authenticated
  using (public.is_league_admin(league_id));

create policy league_membership_admin_notes_insert_admin
  on public.league_membership_admin_notes
  for insert
  to authenticated
  with check (public.is_league_admin(league_id));

create policy league_membership_admin_notes_update_admin
  on public.league_membership_admin_notes
  for update
  to authenticated
  using (public.is_league_admin(league_id))
  with check (public.is_league_admin(league_id));

create policy league_membership_admin_notes_delete_admin
  on public.league_membership_admin_notes
  for delete
  to authenticated
  using (public.is_league_admin(league_id));


-- ── audit_events ───────────────────────────────────────────────────────────
-- Read: the league's active administrator only (02 §4 permission matrix).
-- Write: no policy at all. Events are created through
-- public.record_audit_event() (SECURITY DEFINER, actor derived from the
-- session) or by a service-role connection. A client therefore cannot forge,
-- alter or erase an audit trail even with a valid session.

create policy audit_events_select_admin
  on public.audit_events
  for select
  to authenticated
  using (public.is_league_admin(league_id));


-- ── user_app_state ─────────────────────────────────────────────────────────
-- Strictly own row. The active-league trigger separately requires an active
-- membership in whatever league is selected.

create policy user_app_state_select_self
  on public.user_app_state
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy user_app_state_insert_self
  on public.user_app_state
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy user_app_state_update_self
  on public.user_app_state
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy user_app_state_delete_self
  on public.user_app_state
  for delete
  to authenticated
  using (user_id = (select auth.uid()));

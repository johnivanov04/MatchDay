-- MatchDay — a departing account stops being able to act, immediately.
--
-- ── THE WINDOW THIS EXISTS FOR ─────────────────────────────────────────────
--
-- Account deletion spans Postgres, Storage and GoTrue, and only the first is
-- transactional. So there is a real window — sometimes seconds, sometimes until
-- the reconciler next runs — in which the Postgres side has been scrubbed and
-- the Auth identity still exists. During it `auth.uid()` still resolves to a
-- profile id, and every policy and function in this schema is written in terms
-- of exactly that.
--
-- Without a liveness concept, a tombstoned account with a surviving session
-- could create a league and become its administrator — resurrecting itself
-- completely, from a profile that says it holds no personal data.
--
-- ── WHAT ALREADY PROTECTS US, AND WHY IT IS NOT ENOUGH ─────────────────────
--
-- Deletion sets every membership to `removed`, and all three membership
-- predicates already require a membership that is `active` or not-`removed`.
-- That alone closes 37 of the 52 policies in this database and every league RPC
-- reached through them. It is genuine defence and it stays.
--
-- It is not enough for two reasons. It is a consequence of one step of a
-- multi-step workflow, so it does not hold between `deletion_started_at` and
-- the membership sweep; and it says nothing about the surfaces that need no
-- membership at all — creating a league, requesting to join one, redeeming an
-- invitation, registering a device, editing a profile, uploading a photo.

create or replace function public.is_live_profile()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.deletion_started_at is null
      and p.deleted_at is null
  );
$$;

comment on function public.is_live_profile() is
  'True only for a signed-in account with a profile that is neither deleting '
  'nor deleted. The canonical liveness check: policies and RPCs ask this '
  'rather than each re-deriving it from two nullable columns.';

revoke execute on function public.is_live_profile() from public;
grant execute on function public.is_live_profile() to authenticated, service_role;


-- The companion, for the one policy that must distinguish "no profile" from
-- "a profile that is going away". `is_live_profile()` answers false for both,
-- which is right for authorization and wrong for routing.
create or replace function public.profile_deletion_started()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and (p.deletion_started_at is not null or p.deleted_at is not null)
  );
$$;

comment on function public.profile_deletion_started() is
  'True when the caller has a profile whose deletion has begun. Distinct from '
  'is_live_profile(): a caller with no profile at all is not live and has not '
  'started deleting, and those two must route differently.';

revoke execute on function public.profile_deletion_started() from public;
grant execute on function public.profile_deletion_started() to authenticated, service_role;


-- The same question about somebody else.
--
-- ── WHY THE GUARDS ASK ABOUT THE SUBJECT, NOT THE CALLER ───────────────────
--
-- A rule phrased as "the person acting must be live" leaves the obvious hole
-- wide open: an administrator approving a join request from somebody who is
-- mid-deletion, or adding them by email, is not that person acting. The row
-- would be written by a perfectly live caller and hand a tombstone an active
-- membership.
--
-- Phrased about the row's subject it holds however the row arrives, and covers
-- the caller case too — somebody acting on themselves is their own subject.
create or replace function public.is_live_profile_id(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = p_profile_id
      and p.deletion_started_at is null
      and p.deleted_at is null
  );
$$;

comment on function public.is_live_profile_id(uuid) is
  'Whether the named profile is neither deleting nor deleted. The subject-side '
  'counterpart of is_live_profile(), used by the participation guards so the '
  'rule holds no matter who writes the row.';

revoke execute on function public.is_live_profile_id(uuid) from public;
grant execute on function public.is_live_profile_id(uuid) to authenticated, service_role;


-- ══ The membership predicates ══════════════════════════════════════════════
--
-- Six functions carrying 37 policies and 24 callers between them. Adding the
-- conjunct here rather than at each site is the difference between one reviewed
-- change and thirty-seven unreviewed ones — and a new policy written next year
-- inherits it without anybody remembering to.
--
-- Belt to the membership sweep's braces: either alone refuses a departed
-- account, and the two fail independently.

create or replace function public.is_league_member(p_league_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_live_profile() and exists (
    select 1
    from public.league_memberships m
    where m.league_id = p_league_id
      and m.user_id = auth.uid()
      and m.status <> 'removed'
  );
$$;

create or replace function public.is_league_admin(p_league_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_live_profile() and exists (
    select 1
    from public.league_memberships m
    where m.league_id = p_league_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role = 'league_admin'
  );
$$;

create or replace function public.is_active_member(p_league_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_live_profile() and exists (
    select 1
    from public.league_memberships m
    where m.league_id = p_league_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

create or replace function public.administers_league_of_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_live_profile() and exists (
    select 1
    from public.league_memberships target
    join public.league_memberships administrator
      on administrator.league_id = target.league_id
    where target.user_id = p_user_id
      and target.status <> 'removed'
      and administrator.user_id = auth.uid()
      and administrator.status = 'active'
      and administrator.role = 'league_admin'
  );
$$;

create or replace function public.owns_membership(p_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_live_profile() and exists (
    select 1 from public.league_memberships m
    where m.id = p_membership_id and m.user_id = auth.uid()
  );
$$;

create or replace function public.owns_push_subscription(p_subscription_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_live_profile() and exists (
    select 1 from public.push_subscriptions s
    where s.id = p_subscription_id and s.user_id = auth.uid()
  );
$$;


-- ══ The self-scoped policies ═══════════════════════════════════════════════
--
-- The fifteen policies that compare a column to `auth.uid()` directly are the
-- ones the membership sweep cannot reach. Only the writes need gating: reading
-- your own row reveals nothing to anybody, and one of those reads is load
-- bearing — see below.

-- ── profiles ───────────────────────────────────────────────────────────────
--
-- SELECT IS DELIBERATELY LEFT OPEN, and this is the most consequential decision
-- in the file.
--
-- `getCurrentProfile()` returns null when the row is unreadable, and null means
-- exactly one thing to the application: this person has not onboarded. Gating
-- SELECT would therefore route a departing account to `/onboarding` and invite
-- them to create the profile they are in the middle of deleting — the precise
-- opposite of the requirement. The three states have to stay distinguishable:
--
--     no row                     -> onboarding
--     row, live                  -> MatchDay
--     row, deleting or deleted   -> the deletion-status screen
--
-- Nothing is disclosed by it. The row is the caller's own, and after the scrub
-- it holds nothing personal at all.
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
  on public.profiles
  for update
  to authenticated
  using (id = (select auth.uid()) and public.is_live_profile())
  with check (id = (select auth.uid()) and public.is_live_profile());

-- INSERT cannot ask `is_live_profile()`: somebody completing onboarding has no
-- profile yet, so it would be false and nobody could ever create one. The
-- question here is the opposite one — has this account already started
-- deleting? The primary key would refuse a duplicate anyway; this refuses it
-- with a reason instead of a constraint violation.
drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self
  on public.profiles
  for insert
  to authenticated
  with check (id = (select auth.uid()) and not public.profile_deletion_started());

-- ── user_app_state ─────────────────────────────────────────────────────────
drop policy if exists user_app_state_insert_self on public.user_app_state;
create policy user_app_state_insert_self
  on public.user_app_state
  for insert
  to authenticated
  with check (user_id = (select auth.uid()) and public.is_live_profile());

drop policy if exists user_app_state_update_self on public.user_app_state;
create policy user_app_state_update_self
  on public.user_app_state
  for update
  to authenticated
  using (user_id = (select auth.uid()) and public.is_live_profile())
  with check (user_id = (select auth.uid()) and public.is_live_profile());

drop policy if exists user_app_state_delete_self on public.user_app_state;
create policy user_app_state_delete_self
  on public.user_app_state
  for delete
  to authenticated
  using (user_id = (select auth.uid()) and public.is_live_profile());


-- ── Storage ────────────────────────────────────────────────────────────────
--
-- INSERT is gated and SELECT and DELETE are not, and the asymmetry is the
-- point rather than an oversight.
--
-- Gating INSERT is what makes the cleanup terminating: from the moment
-- `deletion_started_at` is set no new object can appear in the folder, so
-- enumerate-then-delete cannot lose a race against an upload, and a retry after
-- a partial Storage failure is not chasing a moving target.
--
-- Gating DELETE would make the workflow impossible — the account doing the
-- deleting is by definition no longer live, and it is the caller's own session
-- that removes the objects. SELECT stays open for the same reason: the Storage
-- service resolves an object row before removing it, so a caller with DELETE
-- and no SELECT cannot delete their own file.
--
-- Neither is a widening. Both remain scoped to `(storage.foldername(name))[1] =
-- auth.uid()`, which is the entire ownership model — a departing account can
-- still only ever reach inside its own folder, and reaching inside it to empty
-- it is exactly what it is here to do.
drop policy if exists avatars_insert_own on storage.objects;
create policy avatars_insert_own
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.is_live_profile()
  );

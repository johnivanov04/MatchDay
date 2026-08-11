-- Matchday — Phase 4N/4K/4F
-- Row Level Security for signups, and the two roster projections.
--
-- Additive only: no earlier policy or grant is altered or dropped.
--
-- The central problem this migration solves: a member must be able to read the
-- confirmed roster, which means reading other members' names — but `profiles`
-- RLS deliberately gives a player no access to anyone else's profile row, and
-- adding a co-member SELECT policy would hand over `phone` and `gender` too,
-- because RLS filters rows and not columns. Same reasoning as
-- league_membership_admin_notes in Phase 1 and match_admin_notes in Phase 3.
--
-- So the roster is served by a narrow SECURITY DEFINER projection that returns
-- names and nothing else. There is no object to widen by accident.

alter table public.match_signups enable row level security;
alter table public.match_signups force row level security;


-- ── Policies ───────────────────────────────────────────────────────────────
--
-- Read only. There is deliberately no INSERT, UPDATE or DELETE policy for
-- `authenticated`: every write goes through the transactional functions, which
-- take the match lock, enforce capacity, keep waitlist positions contiguous and
-- write the audit event. A direct PostgREST write could do none of that, so the
-- absence of a policy is the architecture, not an omission.

-- A player sees their own row, and only their own. This single predicate is
-- what keeps every other player's waitlist position private: the row itself is
-- invisible, so there is no position to read, count, paginate past or infer
-- from an error. Changing an id in a request returns nothing rather than
-- returning a different answer.
create policy match_signups_select_self
  on public.match_signups for select to authenticated
  using (
    membership_id in (
      select m.id from public.league_memberships m
      where m.user_id = (select auth.uid())
    )
  );

-- The administrator of the league sees every signup for its matches, which is
-- what the roster workspace and the ordered waitlist are.
create policy match_signups_select_admin
  on public.match_signups for select to authenticated
  using (public.is_league_admin(league_id));


-- ── Grants ─────────────────────────────────────────────────────────────────
-- SELECT only, and nothing at all for anon.

grant select on public.match_signups to authenticated;
grant select, insert, update, delete on public.match_signups to service_role;


-- ── Member-facing roster projection ────────────────────────────────────────
--
-- Names of the confirmed players, for an active member of that league. Nothing
-- else crosses this boundary: no phone, no gender, no positions, no goalkeeper
-- flag, no attendance, no administrator note, no response time, no waitlist.
--
-- Returns zero rows rather than raising when the caller may not see the match,
-- so an unknown id and another league's match are indistinguishable from a
-- match with an empty roster.
create or replace function public.match_confirmed_roster(p_match_id uuid)
returns table (
  membership_id uuid,
  first_name text,
  last_name text,
  is_self boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.membership_id, p.first_name, p.last_name,
         m.user_id = auth.uid() as is_self
  from public.match_signups s
  join public.league_memberships m on m.id = s.membership_id
  join public.profiles p on p.id = m.user_id
  join public.matches mt on mt.id = s.match_id
  where s.match_id = p_match_id
    and public.signup_consumes_capacity(s.status)
    -- The caller must be an active member of the league that owns the match,
    -- and the match must have been published at all.
    and public.is_active_member(mt.league_id)
    and mt.published_at is not null
  order by p.first_name, p.last_name, s.membership_id;
$$;

comment on function public.match_confirmed_roster(uuid) is
  'Confirmed players'' names for an active member of the league. Deliberately '
  'narrow: no phone, gender, positions, attendance, notes or waitlist data can '
  'travel through this signature.';


-- ── The caller's own status ────────────────────────────────────────────────
--
-- Separate from the roster because it answers about one person and may include
-- a waitlist position — which is private to its owner. A player asking about
-- somebody else is not possible: there is no parameter for whom to ask about.
create or replace function public.my_match_signup(p_match_id uuid)
returns public.signup_outcome
language sql
stable
security definer
set search_path = ''
as $$
  select (s.status, s.waitlist_position)::public.signup_outcome
  from public.match_signups s
  join public.league_memberships m on m.id = s.membership_id
  where s.match_id = p_match_id
    and m.user_id = auth.uid();
$$;


-- ── Counts a member is allowed to see ──────────────────────────────────────
--
-- Confirmed headcount, capacity and minimum, which together drive the derived
-- needs_players/enough_players/full label and the open-spot count. All three
-- are already member-visible on the match row; this exists so the count can be
-- read without granting anything new.
--
-- The waitlist *size* is included because it tells a member whether joining
-- would put them in a queue, and reveals nothing about who is in it.
create or replace function public.match_signup_counts(p_match_id uuid)
returns table (
  confirmed integer,
  waitlisted integer,
  interested integer,
  capacity integer,
  min_players integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    count(*) filter (where public.signup_consumes_capacity(s.status))::integer,
    count(*) filter (where s.status = 'waitlisted')::integer,
    count(*) filter (where s.status = 'interested')::integer,
    mt.capacity,
    mt.min_players
  from public.matches mt
  left join public.match_signups s on s.match_id = mt.id
  where mt.id = p_match_id
    and mt.published_at is not null
    and (public.is_active_member(mt.league_id) or public.is_league_admin(mt.league_id))
  group by mt.capacity, mt.min_players;
$$;


-- ── Administrator roster workspace ─────────────────────────────────────────
--
-- Everything the administrator needs to choose a roster, and nothing the
-- product does not permit.
--
-- Gender is returned only when the league has enabled the field, matching
-- `leagues.gender_field_enabled`. Phone is never returned: nothing in the
-- selection decision needs it. There is no attendance count and no no-show
-- warning — 02 §11 lists both, but Phase 7 owns attendance and no such data
-- exists. Returning zeroes would be a fabricated statistic that an
-- administrator might act on, so the columns are absent and the workspace is
-- shaped to accept them later.
--
-- There is no skill rating and no code that could compute one.
create or replace function public.match_roster_admin(p_match_id uuid)
returns table (
  signup_id uuid,
  membership_id uuid,
  first_name text,
  last_name text,
  status public.signup_status,
  responded_at timestamptz,
  waitlist_position integer,
  priority_qualified boolean,
  preferred_positions text[],
  goalkeeper_willing boolean,
  gender text,
  membership_status public.membership_status,
  selected_at timestamptz,
  override_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.membership_id, p.first_name, p.last_name,
         s.status, s.responded_at, s.waitlist_position, s.priority_qualified,
         p.preferred_positions,
         case when l.goalkeeper_field_enabled then p.goalkeeper_willing else null end,
         case when l.gender_field_enabled then p.gender else null end,
         m.status,
         s.selected_at, s.override_reason
  from public.match_signups s
  join public.matches mt on mt.id = s.match_id
  join public.leagues l on l.id = mt.league_id
  join public.league_memberships m on m.id = s.membership_id
  join public.profiles p on p.id = m.user_id
  where s.match_id = p_match_id
    and public.is_league_admin(mt.league_id)
  order by s.waitlist_position nulls last, s.responded_at, s.id;
$$;

comment on function public.match_roster_admin(uuid) is
  'Administrator roster workspace. Gender and goalkeeper willingness appear '
  'only when the league enables those fields. No phone, no attendance history, '
  'no disciplinary data, no skill rating.';


-- ── Members an administrator may manually add ──────────────────────────────
--
-- Active members of the league who have not yet responded to this match. Feeds
-- the manual-add picker, so the interface offers only memberships the
-- transaction will accept.
create or replace function public.match_addable_members(p_match_id uuid)
returns table (
  membership_id uuid,
  first_name text,
  last_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id, p.first_name, p.last_name
  from public.matches mt
  join public.league_memberships m on m.league_id = mt.league_id
  join public.profiles p on p.id = m.user_id
  where mt.id = p_match_id
    and public.is_league_admin(mt.league_id)
    and m.status = 'active'
    and not exists (
      select 1 from public.match_signups s
      where s.match_id = mt.id and s.membership_id = m.id
        and s.status in ('confirmed', 'waitlisted')
    )
  order by p.first_name, p.last_name, m.id;
$$;


-- ══ Function EXECUTE, by name ══════════════════════════════════════════════
--
-- PostgreSQL grants EXECUTE to PUBLIC on every new function. Phase 2's
-- `ALTER DEFAULT PRIVILEGES … REVOKE … FROM PUBLIC` silently recorded nothing
-- and every Phase 3 function shipped PUBLIC-executable as a result — see
-- 20260805030900. So each function below is revoked explicitly and granted by
-- name, and tests/db/schema.test.ts asserts that no function in `public` grants
-- EXECUTE to PUBLIC.

-- The trigger function. Nothing may call it directly; PostgreSQL invokes it
-- through the trigger regardless of who holds EXECUTE.
revoke execute on function public.match_signups_guard_status() from public;

-- Internal helpers: reachable only from the SECURITY DEFINER functions that own
-- the invariants. A client that could call compact_waitlist() or
-- lock_match_as_admin() directly gains nothing, but neither is part of the API.
revoke execute on function public.signup_consumes_capacity(public.signup_status) from public;
revoke execute on function public.compact_waitlist(uuid) from public;
revoke execute on function public.lock_match_as_admin(uuid) from public;
revoke execute on function public.next_waitlist_position(uuid) from public;
revoke execute on function public.match_confirmed_count(uuid) from public;
revoke execute on function public.my_active_membership_id(uuid) from public;

grant execute on function public.signup_consumes_capacity(public.signup_status)
  to authenticated, service_role;
grant execute on function public.my_active_membership_id(uuid) to authenticated, service_role;
grant execute on function public.match_confirmed_count(uuid) to authenticated, service_role;
grant execute on function public.compact_waitlist(uuid) to service_role;
grant execute on function public.lock_match_as_admin(uuid) to service_role;
grant execute on function public.next_waitlist_position(uuid) to service_role;

-- Player operations.
revoke execute on function public.match_signup_eligibility(uuid) from public;
revoke execute on function public.join_match(uuid) from public;
revoke execute on function public.request_spot(uuid) from public;
revoke execute on function public.mark_unavailable(uuid) from public;
revoke execute on function public.my_match_signup(uuid) from public;
revoke execute on function public.match_confirmed_roster(uuid) from public;
revoke execute on function public.match_signup_counts(uuid) from public;

grant execute on function public.match_signup_eligibility(uuid) to authenticated, service_role;
grant execute on function public.join_match(uuid) to authenticated, service_role;
grant execute on function public.request_spot(uuid) to authenticated, service_role;
grant execute on function public.mark_unavailable(uuid) to authenticated, service_role;
grant execute on function public.my_match_signup(uuid) to authenticated, service_role;
grant execute on function public.match_confirmed_roster(uuid) to authenticated, service_role;
grant execute on function public.match_signup_counts(uuid) to authenticated, service_role;

-- Administrator operations. Granted to `authenticated` because authorization is
-- inside each function — is_league_admin() against auth.uid() — not at the
-- grant. A player calling one gets NOT_LEAGUE_ADMIN.
revoke execute on function public.set_signup_decision(
  uuid, uuid, public.signup_status, text) from public;
revoke execute on function public.reorder_waitlist(uuid, uuid[]) from public;
revoke execute on function public.add_member_to_match(
  uuid, uuid, public.signup_status, text) from public;
revoke execute on function public.finalize_roster(uuid) from public;
revoke execute on function public.match_roster_admin(uuid) from public;
revoke execute on function public.match_addable_members(uuid) from public;

grant execute on function public.set_signup_decision(
  uuid, uuid, public.signup_status, text) to authenticated, service_role;
grant execute on function public.reorder_waitlist(uuid, uuid[]) to authenticated, service_role;
grant execute on function public.add_member_to_match(
  uuid, uuid, public.signup_status, text) to authenticated, service_role;
grant execute on function public.finalize_roster(uuid) to authenticated, service_role;
grant execute on function public.match_roster_admin(uuid) to authenticated, service_role;
grant execute on function public.match_addable_members(uuid) to authenticated, service_role;

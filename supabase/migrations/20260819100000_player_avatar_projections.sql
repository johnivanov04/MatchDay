-- Matchday — Phase 2 of profile photos: showing a face next to a name.
--
-- Five projections gain one column, `profile_photo_path`. Nothing else changes:
-- no new function, no new join, no new grant, no table grant, no policy, and no
-- alteration to `profiles` Row Level Security.
--
-- ── WHY THIS IS THE WHOLE MIGRATION ────────────────────────────────────────
--
-- Each of these functions already decides who may see a player's *name*. The
-- approved product rule is that a managed avatar is visible exactly where an
-- existing member's identity is already visible — so adding the column to the
-- same SELECT makes the avatar travel precisely as far as the name and no
-- further. A caller who receives zero rows today still receives zero rows.
--
-- The alternative anybody reaches for first — a `profile_avatar(user_id)`
-- lookup — is deliberately not built. It would let any authenticated caller
-- resolve an avatar for an arbitrary id, which is a wider grant than "people
-- whose names you can already see" and could not be narrowed afterwards without
-- breaking clients.
--
-- ── `profile_photo_url` IS NOT HERE, AND NEVER WILL BE ─────────────────────
--
-- The legacy column holds an arbitrary https address on a host nobody here
-- controls. Rendering one inside another member's browser would disclose that
-- member's IP address and user agent to whoever operates it, on a page they
-- never chose to visit. So legacy photos render only on their owner's own
-- profile, through the self-profile flow, and no projection returns the column.
--
-- That invariant is unconditional — it does not soften for the caller's own row
-- inside a roster. A member whose only photo is a legacy address therefore sees
-- initials for themselves on a team sheet, and one upload fixes it. A rule that
-- held "except when is_self" would be correct today and quietly wrong the first
-- time somebody reused the projection.
--
-- ── DROP AND CREATE, NOT REPLACE ───────────────────────────────────────────
--
-- PostgreSQL refuses to change the return type of an existing function through
-- `create or replace`, and an extra output column is a changed return type.
-- Same reason and same shape as `20260813060400_signup_counts_cutoff.sql`.
--
-- Never `cascade`: nothing depends on these functions, and if something ever
-- did, failing loudly is the correct outcome.
--
-- A recreated function is a NEW function, so it arrives with PostgreSQL's
-- built-in EXECUTE-to-PUBLIC default. Every one below is therefore revoked and
-- re-granted explicitly. `tests/db/schema.test.ts` fails the build if one is
-- missed, but relying on that rather than writing it is the wrong way round.
--
-- Every body below is the current definition verbatim, with `p.profile_photo_path`
-- appended to the select list. No predicate, join, feature-flag branch or
-- ORDER BY is touched.


-- ══ 1. Member-facing confirmed roster ══════════════════════════════════════
--
-- Was: 20260811050400. Authorization unchanged — an active member of the
-- league that owns a published match.

drop function if exists public.match_confirmed_roster(uuid);

create or replace function public.match_confirmed_roster(p_match_id uuid)
returns table (
  membership_id uuid,
  first_name text,
  last_name text,
  is_self boolean,
  profile_photo_path text
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.membership_id, p.first_name, p.last_name,
         m.user_id = auth.uid() as is_self,
         p.profile_photo_path
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
  'Confirmed players'' names and managed avatar paths for an active member of '
  'the league. Deliberately narrow: no phone, gender, positions, attendance, '
  'notes or waitlist data can travel through this signature, and no legacy '
  'profile_photo_url.';

revoke execute on function public.match_confirmed_roster(uuid) from public;
grant execute on function public.match_confirmed_roster(uuid) to authenticated, service_role;


-- ══ 2. Administrator roster workspace ══════════════════════════════════════
--
-- Was: 20260811050400. Authorization unchanged — league administrator only.
-- Gender and goalkeeper willingness remain gated on the league's own feature
-- flags, and phone remains absent.

drop function if exists public.match_roster_admin(uuid);

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
  override_reason text,
  profile_photo_path text
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
         s.selected_at, s.override_reason,
         p.profile_photo_path
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
  'no disciplinary data, no skill rating, no legacy profile_photo_url.';

revoke execute on function public.match_roster_admin(uuid) from public;
grant execute on function public.match_roster_admin(uuid) to authenticated, service_role;


-- ══ 3. Team builder ════════════════════════════════════════════════════════
--
-- Was: 20260815070300. Authorization unchanged — league administrator only,
-- confirmed players of an active membership.

drop function if exists public.match_team_builder(uuid);

create or replace function public.match_team_builder(p_match_id uuid)
returns table (
  membership_id uuid,
  first_name text,
  last_name text,
  team_id uuid,
  team_name text,
  display_order integer,
  preferred_positions text[],
  goalkeeper_willing boolean,
  gender text,
  profile_photo_path text
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.membership_id, p.first_name, p.last_name,
         a.team_id, t.name, t.display_order,
         p.preferred_positions,
         case when l.goalkeeper_field_enabled then p.goalkeeper_willing else null end,
         case when l.gender_field_enabled then p.gender else null end,
         p.profile_photo_path
  from public.match_signups s
  join public.matches mt on mt.id = s.match_id
  join public.leagues l on l.id = mt.league_id
  join public.league_memberships m on m.id = s.membership_id
  join public.profiles p on p.id = m.user_id
  left join public.match_team_assignments a
    on a.match_id = s.match_id and a.membership_id = s.membership_id
  left join public.match_teams t on t.id = a.team_id
  where s.match_id = p_match_id
    and public.signup_consumes_capacity(s.status)
    and m.status = 'active'
    and public.is_league_admin(mt.league_id)
  order by t.display_order nulls first, p.first_name, p.last_name;
$$;

revoke execute on function public.match_team_builder(uuid) from public;
grant execute on function public.match_team_builder(uuid) to authenticated, service_role;


-- ══ 4. Published teams ═════════════════════════════════════════════════════
--
-- Was: 20260815070300. Authorization unchanged — the caller must themselves be
-- a currently-confirmed, active player of this published match. The snapshot
-- read, the team_revision pin and the second-line-of-defence confirmation
-- filter are all carried over exactly.

drop function if exists public.match_published_teams(uuid);

create or replace function public.match_published_teams(p_match_id uuid)
returns table (
  team_name text,
  team_label text,
  display_order integer,
  membership_id uuid,
  first_name text,
  last_name text,
  is_self boolean,
  profile_photo_path text
)
language sql
stable
security definer
set search_path = ''
as $$
  select e.team_name, e.team_label, e.display_order, e.membership_id,
         p.first_name, p.last_name,
         m.user_id = auth.uid() as is_self,
         p.profile_photo_path
  from public.matches mt
  join public.match_team_publications pub
    on pub.match_id = mt.id and pub.revision = mt.team_revision
  join public.match_team_publication_entries e on e.publication_id = pub.id
  join public.league_memberships m on m.id = e.membership_id
  join public.profiles p on p.id = m.user_id
  join public.match_signups s
    on s.match_id = mt.id and s.membership_id = e.membership_id
  where mt.id = p_match_id
    and mt.teams_published_at is not null
    -- Still playing. A cancellation already rewrote the snapshot without them,
    -- so this is belt and braces for the paths that do not — a suspended or
    -- removed membership, most of all.
    and public.signup_consumes_capacity(s.status)
    and m.status = 'active'
    -- And the caller must themselves be a confirmed player of this match.
    and exists (
      select 1
      from public.match_signups mine
      join public.league_memberships mym on mym.id = mine.membership_id
      where mine.match_id = mt.id
        and mym.user_id = auth.uid()
        and mym.status = 'active'
        and public.signup_consumes_capacity(mine.status)
    )
  order by e.display_order, p.first_name, p.last_name;
$$;

comment on function public.match_published_teams(uuid) is
  'Published teams for a confirmed player. Names and managed avatar paths only '
  '— no positions, goalkeeper willingness, gender, phone or legacy '
  'profile_photo_url can travel through this signature. Reads the snapshot at '
  'the match''s current team_revision; the confirmation filter is a second line '
  'of defence, not the mechanism.';

revoke execute on function public.match_published_teams(uuid) from public;
grant execute on function public.match_published_teams(uuid) to authenticated, service_role;


-- ══ 5. Attendance workspace ════════════════════════════════════════════════
--
-- Was: 20260817080200. Authorization unchanged — league administrator only,
-- and only players who were ever confirmed. The administrator's private note
-- stays in this signature and reaches nothing a player can call.

drop function if exists public.match_attendance_workspace(uuid);

create or replace function public.match_attendance_workspace(p_match_id uuid)
returns table (
  membership_id uuid,
  first_name text,
  last_name text,
  signup_status public.signup_status,
  canceled_at timestamptz,
  outcome public.attendance_outcome,
  suggested public.attendance_outcome,
  note text,
  revision integer,
  recorded_at timestamptz,
  profile_photo_path text
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.membership_id, p.first_name, p.last_name,
         s.status, s.canceled_at,
         a.outcome,
         public.suggested_attendance_outcome(s.status),
         a.note, a.revision, a.recorded_at,
         p.profile_photo_path
  from public.match_signups s
  join public.matches mt on mt.id = s.match_id
  join public.league_memberships m on m.id = s.membership_id
  join public.profiles p on p.id = m.user_id
  left join public.attendance_records a
    on a.match_id = s.match_id and a.membership_id = s.membership_id
  where s.match_id = p_match_id
    and s.confirmed_at is not null
    and public.is_league_admin(mt.league_id)
  order by a.outcome nulls first, p.first_name, p.last_name;
$$;

revoke execute on function public.match_attendance_workspace(uuid) from public;
grant execute on function public.match_attendance_workspace(uuid)
  to authenticated, service_role;

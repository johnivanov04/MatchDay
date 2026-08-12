-- Matchday — Phase 6J/6Q
-- Who may see teams, and in what form.
--
-- The draft is administrator-only at the table level; the published snapshot is
-- reached only through a projection. That split is the whole privacy model:
-- there is no policy under which a player can read `match_team_assignments`, so
-- an unpublished team cannot leak through a direct PostgREST query, a joined
-- projection, or a Server Component that selects too much.

alter table public.match_teams enable row level security;
alter table public.match_teams force row level security;
alter table public.match_team_assignments enable row level security;
alter table public.match_team_assignments force row level security;
alter table public.match_team_publications enable row level security;
alter table public.match_team_publications force row level security;
alter table public.match_team_publication_entries enable row level security;
alter table public.match_team_publication_entries force row level security;


-- ── Policies ───────────────────────────────────────────────────────────────
--
-- Read-only, administrator-only, and only within their own league. Every write
-- goes through the functions in 20260815070200, which take the match row lock,
-- re-check confirmation and write the audit event — none of which a direct
-- table write could do.

create policy match_teams_select_admin
  on public.match_teams for select to authenticated
  using (public.is_league_admin(league_id));

create policy match_team_assignments_select_admin
  on public.match_team_assignments for select to authenticated
  using (public.is_league_admin(league_id));

-- The snapshots too. A player reads them through `match_published_teams()`,
-- which is SECURITY DEFINER and applies the confirmation rule; the raw tables
-- stay closed so there is no second, unfiltered way in.
create policy match_team_publications_select_admin
  on public.match_team_publications for select to authenticated
  using (public.is_league_admin(league_id));

create policy match_team_publication_entries_select_admin
  on public.match_team_publication_entries for select to authenticated
  using (public.is_league_admin(league_id));


-- ══ Grants ═════════════════════════════════════════════════════════════════

grant select on public.match_teams to authenticated;
grant select on public.match_team_assignments to authenticated;
grant select on public.match_team_publications to authenticated;
grant select on public.match_team_publication_entries to authenticated;

grant select, insert, update, delete on public.match_teams to service_role;
grant select, insert, update, delete on public.match_team_assignments to service_role;
grant select, insert, update, delete on public.match_team_publications to service_role;
grant select, insert, update, delete on public.match_team_publication_entries to service_role;


-- ── What a player sees ─────────────────────────────────────────────────────
--
-- The latest published snapshot, filtered to players who are *currently*
-- confirmed.
--
-- The snapshot is the mechanism: a cancellation writes a new one without the
-- departing player and advances the revision (see
-- `remove_from_published_teams()` in 20260815070400), so every distinct
-- player-visible state has its own `team_revision`.
--
-- The confirmation filter here is a second line of defence rather than that
-- mechanism. It can only ever remove somebody from the view, never add one, so
-- it cannot invent a placement — and it covers the cases the snapshot does not
-- follow, such as a membership suspended or removed by an administrator after
-- publication.
--
-- Access is limited to confirmed players (02 §15: "After publication, confirmed
-- players see every published team"). A waitlisted, not-selected or cancelled
-- member gets nothing — including somebody who was assigned before they
-- cancelled, since they are no longer confirmed.
--
-- Returns zero rows rather than raising when the caller may not see them, so an
-- unpublished match, another league's match and one that does not exist are
-- indistinguishable.
create or replace function public.match_published_teams(p_match_id uuid)
returns table (
  team_name text,
  team_label text,
  display_order integer,
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
  select e.team_name, e.team_label, e.display_order, e.membership_id,
         p.first_name, p.last_name,
         m.user_id = auth.uid() as is_self
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
  'Published teams for a confirmed player. Names only — no positions, '
  'goalkeeper willingness, gender or phone can travel through this signature. '
  'Reads the snapshot at the match''s current team_revision; the confirmation '
  'filter is a second line of defence, not the mechanism.';


-- ── What the administrator sees while building ─────────────────────────────
--
-- Every confirmed player, their draft team if they have one, and the indicators
-- 02 §11 permits. Gender and goalkeeper willingness appear only when the league
-- has enabled those fields, exactly as `match_roster_admin()` already handles
-- them. There is no phone, no attendance and no rating — the MVP has no
-- skill-level field and nothing here infers one.
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
  gender text
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
         case when l.gender_field_enabled then p.gender else null end
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

-- The draft teams themselves, so the builder can render an empty team.
create or replace function public.match_draft_teams(p_match_id uuid)
returns table (
  team_id uuid,
  name text,
  label text,
  display_order integer,
  player_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.name, t.label, t.display_order,
         (select count(*)::integer from public.match_team_assignments a
           where a.team_id = t.id)
  from public.match_teams t
  join public.matches mt on mt.id = t.match_id
  where t.match_id = p_match_id
    and public.is_league_admin(mt.league_id)
  order by t.display_order;
$$;


-- ══ Function EXECUTE, by name ══════════════════════════════════════════════
-- PostgreSQL grants EXECUTE to PUBLIC on every new function; 20260805030900
-- records what that cost the first time it was missed.

revoke execute on function public.match_confirmed_membership_ids(uuid) from public;
revoke execute on function public.ensure_match_teams(uuid) from public;
revoke execute on function public.create_match_team(uuid, text, text) from public;
revoke execute on function public.rename_match_team(uuid, text, text) from public;
revoke execute on function public.delete_match_team(uuid) from public;
revoke execute on function public.assign_player_to_team(uuid, uuid) from public;
revoke execute on function public.unassign_player_from_team(uuid, uuid) from public;
revoke execute on function public.randomize_match_teams(uuid) from public;
revoke execute on function public.publish_match_teams(uuid) from public;
revoke execute on function public.match_published_teams(uuid) from public;
revoke execute on function public.match_team_builder(uuid) from public;
revoke execute on function public.match_draft_teams(uuid) from public;

-- Internal: reached only from the functions above, which own the invariants.
grant execute on function public.match_confirmed_membership_ids(uuid) to service_role;

-- Administrator operations. Granted to `authenticated` because authorization is
-- inside each function — `lock_match_as_admin()` against auth.uid() — not at
-- the grant. A player calling one gets NOT_LEAGUE_ADMIN.
grant execute on function public.ensure_match_teams(uuid) to authenticated, service_role;
grant execute on function public.create_match_team(uuid, text, text)
  to authenticated, service_role;
grant execute on function public.rename_match_team(uuid, text, text)
  to authenticated, service_role;
grant execute on function public.delete_match_team(uuid) to authenticated, service_role;
grant execute on function public.assign_player_to_team(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.unassign_player_from_team(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.randomize_match_teams(uuid) to authenticated, service_role;
grant execute on function public.publish_match_teams(uuid) to authenticated, service_role;
grant execute on function public.match_team_builder(uuid) to authenticated, service_role;
grant execute on function public.match_draft_teams(uuid) to authenticated, service_role;

-- The player projection.
grant execute on function public.match_published_teams(uuid) to authenticated, service_role;

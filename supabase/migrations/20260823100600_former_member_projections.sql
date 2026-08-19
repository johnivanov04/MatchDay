-- MatchDay — what other people see once somebody starts deleting their account.
--
-- ── MASKED IN SQL, NOT IN THE COMPONENT ────────────────────────────────────
--
-- The requirement is that from the moment deletion *begins*, other members stop
-- seeing that person's name and photo — not from the moment the scrub finishes.
-- Those are different instants: between them sits the Storage cleanup and, if
-- it fails, however long it takes a retry or the reconciler to come round.
-- During that window the profile still holds real data.
--
-- So the masking happens here, where the row is assembled, rather than in the
-- component that renders it. A projection that never returns the name cannot
-- leak it through a tooltip, a sort order, a search index, an aria-label or a
-- future screen written by somebody who did not know to check a flag.
--
-- ── THE FLAG IS DERIVED FROM STATE, NOT FROM THE SCRUBBED TEXT ─────────────
--
-- `is_former_member` comes from `deletion_started_at is not null or deleted_at
-- is not null`. It must never be inferred from `first_name = 'Former'` — that
-- is a value the tombstone happens to use because the column is NOT NULL, and
-- somebody genuinely called Former would otherwise be erased from every roster
-- they ever played on.
--
-- ── ONE BEHAVIOURAL FIX, DELIBERATE ────────────────────────────────────────
--
-- `match_published_teams` filtered `m.status = 'active'`, which is right for a
-- match still to be played — a removed member is not turning up, and the team
-- sheet should say so — and wrong for one already played, where it silently
-- shrank the recorded line-up. Measured on a completed match, the published
-- team sheet lost the player entirely.
--
-- That filter is now conditioned on the match still being ahead of us, matching
-- what `withdraw_membership_from_match` already promises when it preserves
-- `confirmed_at` "so if the match has already been played they still appear in
-- its attendance register". Completed fixtures keep their line-ups whether the
-- player left, was removed, or deleted their account.

-- ── DROPPED AND RECREATED, NOT REPLACED ────────────────────────────────────
--
-- All four gain a column, and `CREATE OR REPLACE FUNCTION` cannot change a
-- `RETURNS TABLE` signature — it fails with "cannot change return type of
-- existing function". Each is dropped by its exact identity signature and never
-- with CASCADE: nothing should disappear as a side effect of this, and if
-- something depended on one of them, silence would be the wrong answer.
--
-- A recreated function comes back EXECUTE-able by PUBLIC, which is the hole
-- 20260805030900 closed for everything that existed then and which
-- `tests/db/schema.test.ts` asserts against. Grants are restored at the foot of
-- this file to exactly the two roles each previously held.

drop function if exists public.match_roster_admin(uuid);
drop function if exists public.match_published_teams(uuid);
drop function if exists public.match_attendance_workspace(uuid);
drop function if exists public.match_confirmed_roster(uuid);


-- ── Administrator's roster ─────────────────────────────────────────────────
create function public.match_roster_admin(p_match_id uuid)
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
  profile_photo_path text,
  is_former_member boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.membership_id,
         case when p.deletion_started_at is null and p.deleted_at is null
              then p.first_name else 'Former' end,
         case when p.deletion_started_at is null and p.deleted_at is null
              then p.last_name else 'member' end,
         s.status, s.responded_at, s.waitlist_position, s.priority_qualified,
         case when p.deletion_started_at is null and p.deleted_at is null
              then p.preferred_positions else '{}'::text[] end,
         case when l.goalkeeper_field_enabled
                   and p.deletion_started_at is null and p.deleted_at is null
              then p.goalkeeper_willing else null end,
         case when l.gender_field_enabled
                   and p.deletion_started_at is null and p.deleted_at is null
              then p.gender else null end,
         m.status,
         s.selected_at, s.override_reason,
         case when p.deletion_started_at is null and p.deleted_at is null
              then p.profile_photo_path else null end,
         (p.deletion_started_at is not null or p.deleted_at is not null)
  from public.match_signups s
  join public.matches mt on mt.id = s.match_id
  join public.leagues l on l.id = mt.league_id
  join public.league_memberships m on m.id = s.membership_id
  join public.profiles p on p.id = m.user_id
  where s.match_id = p_match_id
    and public.is_league_admin(mt.league_id)
  order by s.waitlist_position nulls last, s.responded_at, s.id;
$$;


-- ── Published teams ────────────────────────────────────────────────────────
create function public.match_published_teams(p_match_id uuid)
returns table (
  team_name text,
  team_label text,
  display_order integer,
  membership_id uuid,
  first_name text,
  last_name text,
  is_self boolean,
  profile_photo_path text,
  is_former_member boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select e.team_name, e.team_label, e.display_order, e.membership_id,
         case when p.deletion_started_at is null and p.deleted_at is null
              then p.first_name else 'Former' end,
         case when p.deletion_started_at is null and p.deleted_at is null
              then p.last_name else 'member' end,
         m.user_id = auth.uid() as is_self,
         case when p.deletion_started_at is null and p.deleted_at is null
              then p.profile_photo_path else null end,
         (p.deletion_started_at is not null or p.deleted_at is not null)
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
    and public.signup_consumes_capacity(s.status)
    -- Still playing, for a match still ahead. For one already played this is a
    -- record of who was on the pitch, and a departure since then does not
    -- change that. See the header.
    and (m.status = 'active' or mt.kickoff_at <= now())
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


-- ── Attendance workspace ───────────────────────────────────────────────────
create function public.match_attendance_workspace(p_match_id uuid)
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
  profile_photo_path text,
  is_former_member boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.membership_id,
         case when p.deletion_started_at is null and p.deleted_at is null
              then p.first_name else 'Former' end,
         case when p.deletion_started_at is null and p.deleted_at is null
              then p.last_name else 'member' end,
         s.status, s.canceled_at,
         a.outcome,
         public.suggested_attendance_outcome(s.status),
         a.note, a.revision, a.recorded_at,
         case when p.deletion_started_at is null and p.deleted_at is null
              then p.profile_photo_path else null end,
         (p.deletion_started_at is not null or p.deleted_at is not null)
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


-- ── Confirmed roster, as a player sees it ──────────────────────────────────
create function public.match_confirmed_roster(p_match_id uuid)
returns table (
  membership_id uuid,
  first_name text,
  last_name text,
  is_self boolean,
  profile_photo_path text,
  is_former_member boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.membership_id,
         case when p.deletion_started_at is null and p.deleted_at is null
              then p.first_name else 'Former' end,
         case when p.deletion_started_at is null and p.deleted_at is null
              then p.last_name else 'member' end,
         m.user_id = auth.uid() as is_self,
         case when p.deletion_started_at is null and p.deleted_at is null
              then p.profile_photo_path else null end,
         (p.deletion_started_at is not null or p.deleted_at is not null)
  from public.match_signups s
  join public.league_memberships m on m.id = s.membership_id
  join public.profiles p on p.id = m.user_id
  join public.matches mt on mt.id = s.match_id
  where s.match_id = p_match_id
    and public.signup_consumes_capacity(s.status)
    and public.is_active_member(mt.league_id)
    and mt.published_at is not null
  order by p.first_name, p.last_name, s.membership_id;
$$;


-- ── Execution ──────────────────────────────────────────────────────────────
--
-- Revoked then granted to exactly the roles each signature held before it was
-- dropped: `{postgres,authenticated,service_role}`.

revoke execute on function public.match_roster_admin(uuid) from public;
revoke execute on function public.match_published_teams(uuid) from public;
revoke execute on function public.match_attendance_workspace(uuid) from public;
revoke execute on function public.match_confirmed_roster(uuid) from public;

grant execute on function public.match_roster_admin(uuid) to authenticated, service_role;
grant execute on function public.match_published_teams(uuid) to authenticated, service_role;
grant execute on function public.match_attendance_workspace(uuid) to authenticated, service_role;
grant execute on function public.match_confirmed_roster(uuid) to authenticated, service_role;

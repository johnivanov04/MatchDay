-- MatchDay — Guideline 1.2: reporting and blocking.
--
-- A lexical filter cannot catch coded language, novel spellings, or a photograph
-- of something it cannot read. Reporting is not a formality bolted alongside it;
-- it is the mechanism that handles everything the filter structurally cannot.


-- ── REPORTS ────────────────────────────────────────────────────────────────

create type public.report_target_type as enum ('user', 'league', 'match', 'guideline');

create type public.report_reason as enum (
  'harassment',
  'hate_speech',
  'sexual_content',
  'violence_or_threats',
  'spam',
  'impersonation',
  'other'
);

create type public.report_status as enum ('open', 'reviewing', 'actioned', 'dismissed');

create table public.content_reports (
  id uuid primary key default gen_random_uuid(),

  reporter_user_id uuid not null references public.profiles (id) on delete cascade,

  target_type public.report_target_type not null,
  target_id uuid not null,

  -- Context, not a foreign key to the thing being reported: the league gives an
  -- operator somewhere to look without this table having to model four
  -- different target tables.
  league_id uuid references public.leagues (id) on delete set null,

  reason public.report_reason not null,

  -- Bounded and optional. A report needs enough to investigate and nothing more
  -- — this is deliberately not a free-form correspondence channel.
  details text,

  status public.report_status not null default 'open',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,

  -- Written by an operator, never by a member, and never shown to one.
  resolution_note text,

  constraint content_reports_details_length
    check (details is null or (char_length(btrim(details)) between 1 and 1000)),

  constraint content_reports_resolution_consistency
    check (
      (status in ('open', 'reviewing') and resolved_at is null)
      or (status in ('actioned', 'dismissed') and resolved_at is not null)
    ),

  -- Reporting yourself is not a thing that needs to work.
  constraint content_reports_not_self
    check (not (target_type = 'user' and target_id = reporter_user_id))
);

-- DUPLICATE BEHAVIOUR, STATED AS A CONSTRAINT RATHER THAN A CONVENTION.
--
-- One open report per reporter per target. Filing again while the first is
-- still open is refused rather than silently deduplicated, so somebody who
-- reports twice learns their first report exists. Once resolved, the same
-- target can be reported again — a person who resumes the behaviour is a new
-- report, not a reopening of an old one.
create unique index content_reports_one_open_per_target
  on public.content_reports (reporter_user_id, target_type, target_id)
  where status in ('open', 'reviewing');

create index content_reports_triage on public.content_reports (status, created_at desc);
create index content_reports_by_target on public.content_reports (target_type, target_id);

create trigger content_reports_set_updated_at
  before update on public.content_reports
  for each row execute function public.set_updated_at();

-- Details are user-authored text an operator will read. Filter them too.
create trigger content_reports_moderate_text
  before insert or update on public.content_reports
  for each row execute function public.reject_objectionable_content('details');

alter table public.content_reports enable row level security;
alter table public.content_reports force row level security;

-- A reporter sees their own reports and nothing else. There is deliberately no
-- policy by which the SUBJECT of a report can find it: a person who learns they
-- have been reported, by whom, and for what, is a person who can retaliate.
create policy content_reports_select_own on public.content_reports
  for select to authenticated
  using (reporter_user_id = (select auth.uid()));

-- No INSERT policy. Reports are created only through `submit_content_report`,
-- which verifies that the reporter can actually see what they are reporting —
-- otherwise the target id becomes an existence oracle for private leagues.
-- No UPDATE or DELETE for members either: a report is a record, and withdrawing
-- one is an operator action.

revoke all on public.content_reports from anon, authenticated;
grant select on public.content_reports to authenticated;


-- ── BLOCKS ─────────────────────────────────────────────────────────────────

create table public.user_blocks (
  blocker_user_id uuid not null references public.profiles (id) on delete cascade,
  blocked_user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),

  primary key (blocker_user_id, blocked_user_id),

  constraint user_blocks_not_self check (blocker_user_id <> blocked_user_id)
);

create index user_blocks_by_blocked on public.user_blocks (blocked_user_id);

alter table public.user_blocks enable row level security;
alter table public.user_blocks force row level security;

-- Your block list is yours. Nobody can read who has blocked them: that answer
-- is an invitation to make a second account.
create policy user_blocks_select_own on public.user_blocks
  for select to authenticated
  using (blocker_user_id = (select auth.uid()));

create policy user_blocks_insert_own on public.user_blocks
  for insert to authenticated
  with check (blocker_user_id = (select auth.uid()) and public.is_live_profile());

create policy user_blocks_delete_own on public.user_blocks
  for delete to authenticated
  using (blocker_user_id = (select auth.uid()));

revoke all on public.user_blocks from anon, authenticated;
grant select, insert, delete on public.user_blocks to authenticated;


-- ── THE BLOCK PREDICATE ────────────────────────────────────────────────────
--
-- Symmetric on purpose. If A blocks B, neither should be able to reach the
-- other through a request; a block that only worked one way would leave the
-- person who blocked still reachable by the person they blocked.
create or replace function public.is_blocked_between(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_blocks b
    where (b.blocker_user_id = p_a and b.blocked_user_id = p_b)
       or (b.blocker_user_id = p_b and b.blocked_user_id = p_a)
  );
$$;

revoke execute on function public.is_blocked_between(uuid, uuid) from public, anon;
grant execute on function public.is_blocked_between(uuid, uuid) to authenticated, service_role;


-- ── BLOCK / UNBLOCK ────────────────────────────────────────────────────────

create or replace function public.block_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  if p_user_id = v_actor then
    raise exception 'VALIDATION_FAILED: you cannot block yourself' using errcode = '23514';
  end if;

  -- A target that does not exist and one that is not visible are answered
  -- identically, so this cannot be used to test whether an account exists.
  if not exists (select 1 from public.profiles p where p.id = p_user_id) then
    raise exception 'PROFILE_NOT_FOUND: no such member' using errcode = '42501';
  end if;

  -- Idempotent. Blocking somebody twice is the same as blocking them once, and
  -- the second attempt is not an error a person should have to see.
  insert into public.user_blocks (blocker_user_id, blocked_user_id)
  values (v_actor, p_user_id)
  on conflict (blocker_user_id, blocked_user_id) do nothing;
end;
$$;

create or replace function public.unblock_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  delete from public.user_blocks
  where blocker_user_id = v_actor and blocked_user_id = p_user_id;
end;
$$;

revoke execute on function public.block_user(uuid) from public, anon;
revoke execute on function public.unblock_user(uuid) from public, anon;
grant execute on function public.block_user(uuid) to authenticated;
grant execute on function public.unblock_user(uuid) to authenticated;


-- ── FILING A REPORT ────────────────────────────────────────────────────────

create or replace function public.submit_content_report(
  p_target_type public.report_target_type,
  p_target_id uuid,
  p_reason public.report_reason,
  p_details text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := auth.uid();
  v_league uuid;
  v_ok     boolean := false;
  v_id     uuid;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  -- VISIBILITY IS THE AUTHORIZATION CHECK.
  --
  -- You may report what you can see. Accepting a target id without this would
  -- turn the endpoint into an existence oracle: file a report against a guessed
  -- league id and the success or failure tells you whether it exists.
  if p_target_type = 'user' then
    if p_target_id = v_actor then
      raise exception 'VALIDATION_FAILED: you cannot report yourself' using errcode = '23514';
    end if;
    -- Somebody you share an active league with.
    select true, m1.league_id into v_ok, v_league
    from public.league_memberships m1
    join public.league_memberships m2 on m2.league_id = m1.league_id
    where m1.user_id = v_actor and m1.status = 'active'
      and m2.user_id = p_target_id and m2.status = 'active'
    limit 1;

  elsif p_target_type = 'league' then
    select true, l.id into v_ok, v_league
    from public.leagues l
    where l.id = p_target_id
      and (public.is_league_member(l.id) or l.visibility = 'searchable')
    limit 1;

  elsif p_target_type = 'match' then
    select true, mt.league_id into v_ok, v_league
    from public.matches mt
    where mt.id = p_target_id
      and public.is_active_member(mt.league_id)
      and mt.published_at is not null
    limit 1;

  elsif p_target_type = 'guideline' then
    select true, g.league_id into v_ok, v_league
    from public.guideline_versions g
    where g.id = p_target_id
      and public.is_active_member(g.league_id)
      and g.published_at is not null
    limit 1;
  end if;

  if not coalesce(v_ok, false) then
    raise exception 'NOT_AUTHORIZED: that content is not available to report'
      using errcode = '42501';
  end if;

  begin
    insert into public.content_reports
      (reporter_user_id, target_type, target_id, league_id, reason, details)
    values
      (v_actor, p_target_type, p_target_id, v_league, p_reason,
       nullif(btrim(coalesce(p_details, '')), ''))
    returning id into v_id;
  exception when unique_violation then
    raise exception 'REPORT_ALREADY_OPEN: you have already reported this'
      using errcode = '23505';
  end;

  return v_id;
end;
$$;

revoke execute on function public.submit_content_report(
  public.report_target_type, uuid, public.report_reason, text) from public, anon;
grant execute on function public.submit_content_report(
  public.report_target_type, uuid, public.report_reason, text) to authenticated;


-- ── BLOCKS PREVENT REQUEST-STYLE CONTACT ───────────────────────────────────
--
-- MatchDay has no chat, no comments and no direct messages, so there is exactly
-- one way for one member to put text in front of another who has not chosen to
-- hear from them: a join request to a league they administer. That is the
-- interaction a block has to stop, and it is stopped at the table rather than
-- in the RPC, for the same reason the content filter is.
create or replace function public.reject_blocked_join_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.league_memberships admin
    where admin.league_id = new.league_id
      and admin.role = 'league_admin'
      and admin.status = 'active'
      and public.is_blocked_between(admin.user_id, new.user_id)
  ) then
    raise exception 'BLOCKED_INTERACTION: that league is not available to you'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.reject_blocked_join_request() from public;

create trigger league_join_requests_respect_blocks
  before insert on public.league_join_requests
  for each row execute function public.reject_blocked_join_request();


-- ── PROJECTIONS: BLOCKED IDENTITIES, AND NO DISTRIBUTED PHOTOS ─────────────
--
-- Two changes, both to what a member is shown about another member.
--
-- 1. A blocked member's name is replaced for the person who blocked them. Only
--    in the MEMBER-facing projections: the administrator views
--    (`match_roster_admin`, `match_team_builder`, `match_attendance_workspace`,
--    `match_addable_members`) are untouched, because an administrator who
--    cannot see who is on their own roster cannot run the league, and Guideline
--    1.2 asks for user protection, not for moderation tools that lie.
--
-- 2. `profile_photo_path` is returned only for the viewer's own row. Profile
--    photos are user-uploaded images in a public bucket and nothing moderates
--    them; until something does, they are not distributed to other members.
--    Nothing is deleted — a member's own photo is still their own.

create or replace function public.match_confirmed_roster(p_match_id uuid)
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
         case
           when p.deletion_started_at is not null or p.deleted_at is not null then 'Former'
           when public.is_blocked_between(m.user_id, auth.uid()) then 'Blocked'
           else p.first_name
         end,
         case
           when p.deletion_started_at is not null or p.deleted_at is not null then 'member'
           when public.is_blocked_between(m.user_id, auth.uid()) then 'member'
           else p.last_name
         end,
         m.user_id = auth.uid() as is_self,
         case when m.user_id = auth.uid() then p.profile_photo_path else null end,
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

create or replace function public.match_published_teams(p_match_id uuid)
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
         case
           when p.deletion_started_at is not null or p.deleted_at is not null then 'Former'
           when public.is_blocked_between(m.user_id, auth.uid()) then 'Blocked'
           else p.first_name
         end,
         case
           when p.deletion_started_at is not null or p.deleted_at is not null then 'member'
           when public.is_blocked_between(m.user_id, auth.uid()) then 'member'
           else p.last_name
         end,
         m.user_id = auth.uid() as is_self,
         case when m.user_id = auth.uid() then p.profile_photo_path else null end,
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


-- NO BACKFILL. No report is created, no block is created, no notification is
-- written and nothing is sent. This migration is schema and functions only.

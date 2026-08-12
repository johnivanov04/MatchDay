-- Matchday — Phase 6D/6E/6G/6H/6I/6K
-- Building teams, and publishing them.
--
-- Every function here takes `lock_match_as_admin()` first — the same
-- `select ... for update` on the match row that Phase 4's join, Phase 4's
-- roster decisions and Phase 5's cancellation take. One lock, one ordering, so
-- a team mutation and a cancellation queue behind each other rather than
-- interleaving.
--
-- That matters more here than anywhere else in the product, because Phase 6
-- adds an invariant that Phase 5 can invalidate at any moment: only a confirmed
-- player may be assigned. Every function below therefore re-reads confirmation
-- status *after* acquiring the lock, never before.


-- ── Who may be on a team ───────────────────────────────────────────────────
--
-- Exactly the players who consume a capacity slot. Reusing Phase 4's predicate
-- rather than restating `status = 'confirmed'` keeps one definition of "is
-- playing" across signup, capacity, reminders and teams.
create or replace function public.match_confirmed_membership_ids(p_match_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.membership_id
  from public.match_signups s
  join public.league_memberships m on m.id = s.membership_id
  where s.match_id = p_match_id
    and public.signup_consumes_capacity(s.status)
    and m.status = 'active';
$$;


-- ── Initialising the draft ─────────────────────────────────────────────────
--
-- Called when the builder is first opened. Creates the match's configured
-- number of teams, named Team 1..N, and does nothing at all if any team
-- already exists — so opening the page twice does not double the teams.
--
-- The count comes from `matches.team_count`, which `create_match()` already
-- seeds from the league default. Nothing here assumes two.
create or replace function public.ensure_match_teams(p_match_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match public.matches;
  v_existing integer;
  v_index integer;
begin
  v_match := public.lock_match_as_admin(p_match_id);

  select count(*) into v_existing from public.match_teams t where t.match_id = p_match_id;
  if v_existing > 0 then
    return v_existing;
  end if;

  for v_index in 1..greatest(v_match.team_count, 2) loop
    insert into public.match_teams (league_id, match_id, name, display_order)
    values (v_match.league_id, p_match_id, 'Team ' || v_index::text, v_index);
  end loop;

  return greatest(v_match.team_count, 2);
end;
$$;


-- ── Creating, renaming and removing a team ─────────────────────────────────

create or replace function public.create_match_team(
  p_match_id uuid,
  p_name text default null,
  p_label text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_order integer;
  v_team_id uuid;
begin
  v_match := public.lock_match_as_admin(p_match_id);

  select coalesce(max(t.display_order), 0) + 1 into v_order
  from public.match_teams t where t.match_id = p_match_id;

  if v_order > 20 then
    raise exception 'TEAM_LIMIT_REACHED: a match may have at most 20 teams'
      using errcode = 'P0001';
  end if;

  insert into public.match_teams (league_id, match_id, name, label, display_order)
  values (
    v_match.league_id, p_match_id,
    coalesce(nullif(btrim(coalesce(p_name, '')), ''), 'Team ' || v_order::text),
    nullif(btrim(coalesce(p_label, '')), ''),
    v_order
  )
  returning id into v_team_id;

  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match_team', p_match_id, 'team.created',
    null,
    jsonb_build_object('team_id', v_team_id, 'display_order', v_order),
    null
  );

  return v_team_id;
end;
$$;

create or replace function public.rename_match_team(
  p_team_id uuid,
  p_name text,
  p_label text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_team public.match_teams;
  v_match public.matches;
begin
  select * into v_team from public.match_teams t where t.id = p_team_id;
  if not found then
    raise exception 'NOT_LEAGUE_ADMIN: no such team' using errcode = '42501';
  end if;

  -- Authorization comes from the team's own match, so a caller cannot name a
  -- team in a league they do not administer.
  v_match := public.lock_match_as_admin(v_team.match_id);

  update public.match_teams
     set name = btrim(p_name),
         label = nullif(btrim(coalesce(p_label, '')), '')
   where id = p_team_id;

  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match_team', v_team.match_id, 'team.renamed',
    jsonb_build_object('team_id', p_team_id),
    jsonb_build_object('team_id', p_team_id),
    null
  );

  return p_team_id;
end;
$$;

-- Deleting a team leaves its players UNASSIGNED rather than moving them
-- somewhere. Silently relocating people is the one behaviour an administrator
-- cannot undo by looking at the screen, and the builder shows unassigned
-- players prominently, so the state after this is obvious and correctable.
--
-- The published snapshot is untouched: it stores team names as text precisely
-- so that deleting a draft team cannot erase what was already announced.
create or replace function public.delete_match_team(p_team_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_team public.match_teams;
  v_match public.matches;
  v_unassigned integer;
begin
  select * into v_team from public.match_teams t where t.id = p_team_id;
  if not found then
    raise exception 'NOT_LEAGUE_ADMIN: no such team' using errcode = '42501';
  end if;

  v_match := public.lock_match_as_admin(v_team.match_id);

  with removed as (
    delete from public.match_team_assignments a where a.team_id = p_team_id returning 1
  )
  select count(*) into v_unassigned from removed;

  delete from public.match_teams where id = p_team_id;

  -- Renumber so the ordering stays 1..N with no gap, the same contiguity rule
  -- the waitlist keeps.
  set constraints public.match_teams_order_key deferred;
  with ordered as (
    select t.id, row_number() over (order by t.display_order, t.created_at, t.id) as position
    from public.match_teams t where t.match_id = v_team.match_id
  )
  update public.match_teams t
     set display_order = ordered.position
    from ordered
   where t.id = ordered.id and t.display_order is distinct from ordered.position;

  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match_team', v_team.match_id, 'team.deleted',
    jsonb_build_object('team_id', p_team_id),
    jsonb_build_object('unassigned_count', v_unassigned),
    null
  );

  return v_unassigned;
end;
$$;


-- ── Assigning, moving and unassigning ──────────────────────────────────────
--
-- One function for assign and move: they differ only in whether a row already
-- exists, and the unique constraint on (match_id, membership_id) makes the
-- upsert the move.
create or replace function public.assign_player_to_team(
  p_team_id uuid,
  p_membership_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_team public.match_teams;
  v_match public.matches;
  v_previous uuid;
begin
  select * into v_team from public.match_teams t where t.id = p_team_id;
  if not found then
    raise exception 'NOT_LEAGUE_ADMIN: no such team' using errcode = '42501';
  end if;

  v_match := public.lock_match_as_admin(v_team.match_id);

  -- RE-CHECKED UNDER THE LOCK, not before it. A cancellation committed while
  -- this request was queuing would otherwise let a player who is no longer
  -- playing be put on a team.
  if not exists (
    select 1 from public.match_confirmed_membership_ids(v_team.match_id) id
    where id = p_membership_id
  ) then
    raise exception 'TEAM_ASSIGNMENT_INVALID: only a confirmed player can be assigned'
      using errcode = 'P0001';
  end if;

  select a.team_id into v_previous
  from public.match_team_assignments a
  where a.match_id = v_team.match_id and a.membership_id = p_membership_id;

  insert into public.match_team_assignments (
    league_id, match_id, team_id, membership_id, assigned_by, assigned_at
  )
  values (v_match.league_id, v_team.match_id, p_team_id, p_membership_id, v_actor, now())
  on conflict (match_id, membership_id) do update
    set team_id = excluded.team_id,
        assigned_by = excluded.assigned_by,
        assigned_at = excluded.assigned_at;

  -- Membership and team ids only: an audit row is readable by every future
  -- administrator, and a name adds nothing an id cannot resolve.
  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match_team', v_team.match_id,
    case when v_previous is null then 'team.player_assigned' else 'team.player_moved' end,
    case when v_previous is null then null
         else jsonb_build_object('membership_id', p_membership_id, 'team_id', v_previous) end,
    jsonb_build_object('membership_id', p_membership_id, 'team_id', p_team_id),
    null
  );

  return p_team_id;
end;
$$;

create or replace function public.unassign_player_from_team(
  p_match_id uuid,
  p_membership_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_removed integer;
begin
  v_match := public.lock_match_as_admin(p_match_id);

  with removed as (
    delete from public.match_team_assignments a
     where a.match_id = p_match_id and a.membership_id = p_membership_id
    returning 1
  )
  select count(*) into v_removed from removed;

  if v_removed = 0 then
    return false;
  end if;

  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match_team', p_match_id, 'team.player_unassigned',
    jsonb_build_object('membership_id', p_membership_id), null, null
  );

  return true;
end;
$$;


-- ── Randomize ──────────────────────────────────────────────────────────────
--
-- COUNT ONLY, and that is a product decision rather than a simplification.
-- 04 §3 settled it: "Equal-size random assignment only. Show position,
-- goalkeeper and gender information so the administrator can adjust manually.
-- Do not call it balanced."
--
-- So the ordering is `random()` and nothing else. Position, goalkeeper
-- willingness, gender, attendance, priority and signup time are all available
-- in the same transaction and none of them is read. There is deliberately no
-- weighting, no seeding by any player attribute, and no score of any kind for
-- a future change to reach for.
--
-- Round-robin dealing over a shuffled list gives sizes differing by at most
-- one, which is the whole guarantee: 22 over 3 teams is 8/7/7, never 10/6/6.
create or replace function public.randomize_match_teams(p_match_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_team_count integer;
  v_assigned integer;
begin
  v_match := public.lock_match_as_admin(p_match_id);

  select count(*) into v_team_count from public.match_teams t where t.match_id = p_match_id;
  if v_team_count < 2 then
    raise exception 'TEAM_ASSIGNMENT_INVALID: a match needs at least two teams'
      using errcode = 'P0001';
  end if;

  -- Replaces the whole draft layout rather than filling the gaps, so the result
  -- is a fresh shuffle and not a reshuffle of whoever happened to be spare.
  delete from public.match_team_assignments where match_id = p_match_id;

  with shuffled as (
    select id as membership_id,
           row_number() over (order by random()) - 1 as position
    from public.match_confirmed_membership_ids(p_match_id) id
  ),
  teams as (
    select t.id as team_id,
           row_number() over (order by t.display_order) - 1 as slot
    from public.match_teams t where t.match_id = p_match_id
  ),
  dealt as (
    insert into public.match_team_assignments (
      league_id, match_id, team_id, membership_id, assigned_by, assigned_at
    )
    select v_match.league_id, p_match_id, teams.team_id, shuffled.membership_id, v_actor, now()
    from shuffled
    join teams on teams.slot = shuffled.position % v_team_count
    returning 1
  )
  select count(*) into v_assigned from dealt;

  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match_team', p_match_id, 'team.randomized',
    null,
    jsonb_build_object('team_count', v_team_count, 'assignment_count', v_assigned),
    null
  );

  return v_assigned;
end;
$$;


-- ── Publishing ─────────────────────────────────────────────────────────────
--
-- The communication boundary. Everything before it is private; this is the one
-- moment players are told anything.
--
-- Idempotent by content: if the draft is identical to what was last published,
-- the revision does not move and nobody is notified again. That makes a
-- double-tap, a retry after a lost response and a refresh all harmless, without
-- needing a request identifier from the browser.
create or replace function public.publish_match_teams(p_match_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_team_count integer;
  v_confirmed integer;
  v_assigned integer;
  v_unchanged boolean;
  v_revision integer;
  v_publication_id uuid;
  v_slug text;
  v_first boolean;
  v_type public.notification_type;
  v_recipient record;
begin
  v_match := public.lock_match_as_admin(p_match_id);

  if v_match.status = 'canceled' then
    raise exception 'MATCH_NOT_OPEN: a canceled match cannot publish teams'
      using errcode = 'P0001';
  end if;

  select count(*) into v_team_count from public.match_teams t where t.match_id = p_match_id;
  if v_team_count < 2 then
    raise exception 'TEAM_ASSIGNMENT_INVALID: publish at least two teams'
      using errcode = 'P0001';
  end if;

  select count(*) into v_confirmed
  from public.match_confirmed_membership_ids(p_match_id) id;

  if v_confirmed = 0 then
    raise exception 'TEAM_ASSIGNMENT_INVALID: nobody is confirmed for this match'
      using errcode = 'P0001';
  end if;

  -- Every confirmed player, assigned exactly once. Publishing with somebody
  -- missing would tell the rest of the team a roster that is not the roster.
  select count(*) into v_assigned
  from public.match_team_assignments a
  where a.match_id = p_match_id
    and a.membership_id in (select id from public.match_confirmed_membership_ids(p_match_id) id);

  if v_assigned <> v_confirmed then
    raise exception
      'TEAM_ASSIGNMENT_INVALID: % of % confirmed players are not on a team',
      v_confirmed - v_assigned, v_confirmed
      using errcode = 'P0001';
  end if;

  -- Idempotency, by comparing the draft against the last published snapshot.
  -- Both sides are reduced to the same shape so the comparison is about who is
  -- on which named team, not about row ids or timestamps.
  v_unchanged := v_match.teams_published_at is not null and not exists (
    (
      select a.membership_id, t.name, t.label, t.display_order
      from public.match_team_assignments a
      join public.match_teams t on t.id = a.team_id
      where a.match_id = p_match_id
        and a.membership_id in (select id from public.match_confirmed_membership_ids(p_match_id) id)
      except
      select e.membership_id, e.team_name, e.team_label, e.display_order
      from public.match_team_publication_entries e
      join public.match_team_publications p on p.id = e.publication_id
      where p.match_id = p_match_id and p.revision = v_match.team_revision
    )
    union all
    (
      select e.membership_id, e.team_name, e.team_label, e.display_order
      from public.match_team_publication_entries e
      join public.match_team_publications p on p.id = e.publication_id
      where p.match_id = p_match_id and p.revision = v_match.team_revision
      except
      select a.membership_id, t.name, t.label, t.display_order
      from public.match_team_assignments a
      join public.match_teams t on t.id = a.team_id
      where a.match_id = p_match_id
        and a.membership_id in (select id from public.match_confirmed_membership_ids(p_match_id) id)
    )
  );

  if v_unchanged then
    return v_match.team_revision;
  end if;

  v_first := v_match.teams_published_at is null;
  v_revision := v_match.team_revision + 1;

  insert into public.match_team_publications (league_id, match_id, revision, published_by)
  values (v_match.league_id, p_match_id, v_revision, v_actor)
  returning id into v_publication_id;

  -- One statement, so a snapshot is whole or absent. There is no intermediate
  -- state in which half the teams have been announced.
  insert into public.match_team_publication_entries (
    publication_id, league_id, match_id, membership_id, team_name, team_label, display_order
  )
  select v_publication_id, v_match.league_id, p_match_id, a.membership_id,
         t.name, t.label, t.display_order
  from public.match_team_assignments a
  join public.match_teams t on t.id = a.team_id
  where a.match_id = p_match_id
    and a.membership_id in (select id from public.match_confirmed_membership_ids(p_match_id) id);

  update public.matches
     set team_revision = v_revision,
         teams_published_at = now()
   where id = p_match_id;

  select l.slug into v_slug from public.leagues l where l.id = v_match.league_id;
  v_type := case when v_first then 'teams_published'::public.notification_type
                 else 'teams_changed'::public.notification_type end;

  -- Only the players who may see the teams are told about them. A waitlisted,
  -- not-selected or canceled member is not among them.
  for v_recipient in
    select m.user_id, s.membership_id
    from public.match_signups s
    join public.league_memberships m on m.id = s.membership_id
    where s.match_id = p_match_id
      and public.signup_consumes_capacity(s.status)
      and m.status = 'active'
  loop
    perform public.create_notification(
      v_recipient.user_id, v_match.league_id, v_type,
      case when v_first then 'Teams are up: ' || v_match.title
           else 'Teams changed: ' || v_match.title end,
      to_char(v_match.kickoff_at at time zone v_match.timezone, 'Dy DD Mon HH24:MI')
        || ' at ' || v_match.location_name,
      '/leagues/' || v_slug || '/matches/' || p_match_id::text,
      -- Keyed on the revision, so a retry of one publication says nothing twice
      -- while a genuine later publication still gets through.
      'teams:' || p_match_id::text || ':' || v_revision::text
        || ':' || v_recipient.membership_id::text,
      p_match_id,
      jsonb_build_object('push_eligible', true)
    );
  end loop;

  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match', p_match_id,
    case when v_first then 'teams.published' else 'teams.republished' end,
    jsonb_build_object('team_revision', v_match.team_revision),
    jsonb_build_object('team_revision', v_revision,
                       'team_count', v_team_count,
                       'assignment_count', v_assigned),
    null
  );

  return v_revision;
end;
$$;


-- ── Cancellation drops the draft assignment ────────────────────────────────
--
-- Recreated from 20260813060200 with one added statement. Everything else — the
-- classification, the capacity release, the promotion, the receipt, the audit —
-- is unchanged.
--
-- WHY THE DRAFT AND NOT THE SNAPSHOT. The published snapshot is history: it
-- records what was announced, and rewriting it would make the record a lie.
-- What players *see* is the snapshot filtered to currently-confirmed players
-- (see `match_published_teams()`), so a cancellation removes somebody from the
-- visible teams the moment it commits, with no revision bump and no
-- notification. Only the administrator's working copy needs clearing, so the
-- builder shows the gap that now needs filling.
create or replace function public.cancel_spot(
  p_match_id uuid,
  p_reason text default null
)
returns public.signup_outcome
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_membership uuid;
  v_existing public.match_signups;
  v_was_confirmed boolean;
  v_late boolean;
  v_status public.signup_status;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_revision integer;
  v_promoted uuid;
  v_slug text;
  v_admin uuid;
  v_outcome public.signup_outcome;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  select * into v_match from public.matches m where m.id = p_match_id for update;

  if not found or v_match.published_at is null then
    raise exception 'MEMBERSHIP_REQUIRED: no such match' using errcode = '42501';
  end if;

  v_membership := public.my_active_membership_id(v_match.league_id);
  if v_membership is null then
    raise exception 'MEMBERSHIP_REQUIRED: not an active member of that league'
      using errcode = '42501';
  end if;

  select * into v_existing
  from public.match_signups s
  where s.match_id = p_match_id and s.membership_id = v_membership;

  if not found then
    raise exception 'NOT_AUTHORIZED: you have no signup for that match'
      using errcode = '42501';
  end if;

  if v_existing.status in ('canceled', 'withdrawn_late') then
    v_outcome := (v_existing.status, null);
    return v_outcome;
  end if;

  if v_existing.status not in ('confirmed', 'waitlisted') then
    raise exception
      'SIGNUP_DECISION_INVALID: only a confirmed spot or a waitlist place can be cancelled'
      using errcode = 'P0001';
  end if;

  v_was_confirmed := public.signup_consumes_capacity(v_existing.status);

  v_late := v_was_confirmed and now() > v_match.cancellation_cutoff_at;
  v_status := case when v_late then 'withdrawn_late' else 'canceled' end;

  update public.match_signups
     set status = v_status,
         canceled_at = now(),
         cancellation_reason = v_reason,
         waitlist_position = null,
         selected_by = null,
         selected_at = null
   where match_id = p_match_id and membership_id = v_membership;

  -- Phase 6: somebody who is not playing cannot hold a place on a team.
  delete from public.match_team_assignments
   where match_id = p_match_id and membership_id = v_membership;

  perform public.compact_waitlist(p_match_id);

  select l.slug into v_slug from public.leagues l where l.id = v_match.league_id;

  v_revision := public.advance_roster_revision_if_published(p_match_id);

  if v_revision is not null then
    update public.match_signups
       set published_status = v_status
     where match_id = p_match_id and membership_id = v_membership;
  end if;

  if v_was_confirmed then
    if v_match.waitlist_mode = 'automatic' then
      -- A promoted player starts with no team. Putting them straight into the
      -- vacated place would be a selection decision the administrator has not
      -- made, and the two are rarely interchangeable.
      v_promoted := public.promote_next_waitlisted(p_match_id, v_actor, v_revision);
    else
      select m.user_id into v_admin
      from public.league_memberships m
      where m.league_id = v_match.league_id
        and m.role = 'league_admin'
        and m.status = 'active';

      if v_admin is not null then
        perform public.create_notification(
          v_admin, v_match.league_id, 'replacement_needed',
          'A spot opened: ' || v_match.title,
          'Somebody withdrew. Open the roster to choose a replacement.',
          '/leagues/' || v_slug || '/matches/' || p_match_id::text || '/roster',
          'replacement_needed:' || p_match_id::text || ':' || v_membership::text,
          p_match_id,
          jsonb_build_object('push_eligible', true)
        );
      end if;
    end if;
  end if;

  perform public.create_notification(
    v_actor, v_match.league_id, 'cancellation_receipt',
    case when v_was_confirmed then 'Cancelled: ' || v_match.title
         else 'Left the waitlist: ' || v_match.title end,
    case
      when v_late then
        'Recorded after the cancellation cutoff. Your league administrator has been told.'
      when v_was_confirmed then 'Recorded before the cutoff. Your spot has been released.'
      else 'You are no longer on the waitlist for this match.'
    end,
    '/leagues/' || v_slug || '/matches/' || p_match_id::text,
    'cancellation_receipt:' || p_match_id::text || ':' || v_membership::text
      || ':' || v_status::text,
    p_match_id,
    jsonb_build_object('push_eligible', false)
  );

  if v_late then
    select m.user_id into v_admin
    from public.league_memberships m
    where m.league_id = v_match.league_id
      and m.role = 'league_admin'
      and m.status = 'active';

    if v_admin is not null then
      perform public.create_notification(
        v_admin, v_match.league_id, 'late_cancellation',
        'Late withdrawal: ' || v_match.title,
        'A player withdrew after the cancellation cutoff. Open the roster for details.',
        '/leagues/' || v_slug || '/matches/' || p_match_id::text || '/roster',
        'late_cancellation:' || p_match_id::text || ':' || v_membership::text,
        p_match_id,
        jsonb_build_object('push_eligible', true)
      );
    end if;
  end if;

  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match_signup', p_match_id, 'signup.canceled',
    jsonb_build_object('membership_id', v_membership,
                       'status', v_existing.status::text),
    jsonb_build_object('membership_id', v_membership,
                       'status', v_status::text,
                       'late', v_late,
                       'had_reason', v_reason is not null,
                       'released_capacity', v_was_confirmed,
                       'promoted_membership_id', v_promoted,
                       'roster_revision', v_revision),
    null
  );

  v_outcome := (v_status, null);
  return v_outcome;
end;
$$;

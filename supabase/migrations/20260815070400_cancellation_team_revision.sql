-- Matchday — Phase 6K, corrected
-- A cancellation after publication is a change to the published teams.
--
-- WHAT WAS WRONG. 20260815070200 left the published snapshot untouched when a
-- confirmed player cancelled and relied on the player projection filtering to
-- currently-confirmed players. The canceled player did disappear from view, but
-- two things followed that should not have:
--
--   * one `team_revision` could describe two different player-visible states —
--     before and after the withdrawal — so the revision stopped identifying
--     what a player had actually been shown;
--   * nobody was told. 02 §15 is explicit: "Team changes after publication
--     create notifications." Somebody's team losing a player is precisely such
--     a change, and the people left on that team are the ones who most need to
--     know they are a player short.
--
-- It was also inconsistent with this repository's own precedent. Phase 5's
-- `advance_roster_revision_if_published()` already advances `roster_revision`
-- when a cancellation changes a *published roster*; teams had no reason to
-- behave differently.
--
-- WHAT THIS DOES. A cancellation that removes somebody from the current
-- published snapshot now writes a new snapshot — the previous one minus that
-- player — advances `team_revision` exactly once, and notifies the remaining
-- confirmed players once. Every distinct player-visible state has its own
-- revision again.


-- ── Removing one player from the published teams ───────────────────────────
--
-- Copies the current snapshot forward without the departing player, rather than
-- publishing the administrator's draft. That distinction matters: the draft may
-- hold unpublished edits, and a cancellation must not leak them. The only thing
-- that changes is the one player who is no longer playing.
--
-- Returns the new revision, or NULL when there was nothing to change — teams
-- were never published, or this player was not in the published snapshot.
-- Callers use that NULL to decide whether to notify.
create or replace function public.remove_from_published_teams(
  p_match_id uuid,
  p_membership_id uuid,
  p_actor uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match public.matches;
  v_current_id uuid;
  v_revision integer;
  v_publication_id uuid;
begin
  select * into v_match from public.matches m where m.id = p_match_id;

  if not found or v_match.teams_published_at is null then
    return null;
  end if;

  select p.id into v_current_id
  from public.match_team_publications p
  where p.match_id = p_match_id and p.revision = v_match.team_revision;

  if v_current_id is null then
    return null;
  end if;

  -- Nothing to do if they were not on a published team: somebody who joined
  -- after publication, or who was never assigned, changes nothing by leaving.
  if not exists (
    select 1 from public.match_team_publication_entries e
    where e.publication_id = v_current_id and e.membership_id = p_membership_id
  ) then
    return null;
  end if;

  v_revision := v_match.team_revision + 1;

  insert into public.match_team_publications (league_id, match_id, revision, published_by)
  values (v_match.league_id, p_match_id, v_revision, p_actor)
  returning id into v_publication_id;

  -- One statement, so the new snapshot is whole or absent.
  insert into public.match_team_publication_entries (
    publication_id, league_id, match_id, membership_id, team_name, team_label, display_order
  )
  select v_publication_id, e.league_id, e.match_id, e.membership_id,
         e.team_name, e.team_label, e.display_order
  from public.match_team_publication_entries e
  where e.publication_id = v_current_id
    and e.membership_id <> p_membership_id;

  update public.matches
     set team_revision = v_revision,
         teams_published_at = now()
   where id = p_match_id;

  return v_revision;
end;
$$;


-- ── Cancellation, with the teams kept honest ───────────────────────────────
--
-- Recreated from 20260815070200 with the team-revision handling added. The
-- classification, the capacity release, the waitlist compaction, the promotion,
-- the receipt, the late alert and the audit event are unchanged.
--
-- The whole thing remains one transaction under the match row lock taken at the
-- top, so the withdrawal, the released capacity, the promotion and the new
-- published snapshot commit together or not at all.
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
  v_team_revision integer;
  v_promoted uuid;
  v_slug text;
  v_admin uuid;
  v_recipient record;
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

  -- Idempotent. A double tap, a refresh or a retry after a lost response
  -- returns the standing outcome rather than releasing a second slot, promoting
  -- a second player, sending a second receipt or advancing the team revision
  -- again.
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

  -- Somebody who is not playing cannot hold a place on a team.
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

  -- ── The published teams ─────────────────────────────────────────────────
  -- Copies the snapshot forward without them, and advances the revision, so
  -- the state players see keeps its own identity. NULL when they were not on a
  -- published team, in which case nothing visible changed and nobody is told.
  v_team_revision := public.remove_from_published_teams(p_match_id, v_membership, v_actor);

  if v_was_confirmed then
    if v_match.waitlist_mode = 'automatic' then
      -- The promoted player starts with no team. Dropping them into the
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

  -- ── Telling the others their teams changed ──────────────────────────────
  --
  -- After the promotion, deliberately: a player promoted into this vacancy is
  -- confirmed by now and should hear that teams exist and that they are not yet
  -- on one.
  --
  -- Keyed on the new revision, so a retry cannot duplicate it and a later
  -- genuine change still gets through. The canceling player is excluded — they
  -- receive their own receipt and are no longer on a team.
  if v_team_revision is not null then
    for v_recipient in
      select m.user_id, s.membership_id
      from public.match_signups s
      join public.league_memberships m on m.id = s.membership_id
      where s.match_id = p_match_id
        and public.signup_consumes_capacity(s.status)
        and m.status = 'active'
        and s.membership_id <> v_membership
    loop
      perform public.create_notification(
        v_recipient.user_id, v_match.league_id, 'teams_changed',
        'Teams changed: ' || v_match.title,
        to_char(v_match.kickoff_at at time zone v_match.timezone, 'Dy DD Mon HH24:MI')
          || ' at ' || v_match.location_name,
        '/leagues/' || v_slug || '/matches/' || p_match_id::text,
        'teams:' || p_match_id::text || ':' || v_team_revision::text
          || ':' || v_recipient.membership_id::text,
        p_match_id,
        jsonb_build_object('push_eligible', true)
      );
    end loop;
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
                       'roster_revision', v_revision,
                       'team_revision', v_team_revision),
    null
  );

  v_outcome := (v_status, null);
  return v_outcome;
end;
$$;


-- ── Grants ─────────────────────────────────────────────────────────────────
-- Internal: a consequence of a cancellation, never something a caller asks for.
revoke execute on function public.remove_from_published_teams(uuid, uuid, uuid) from public;
grant execute on function public.remove_from_published_teams(uuid, uuid, uuid) to service_role;

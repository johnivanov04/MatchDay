-- Matchday — Phase 5C/5D/5E/5F
-- Cancellation, and what happens to the spot it frees.
--
-- Same concurrency discipline as Phase 4: `select ... from matches where id =
-- $1 for update` is the first statement of every function here, so a
-- cancellation, a join, an administrator decision and a promotion all queue
-- behind one another on the same row and none can deadlock against another.
--
-- The single most important invariant: **one freed slot promotes at most one
-- player.** It holds because the cancellation, the capacity release and the
-- promotion are one transaction under one lock, so a second canceller cannot
-- read a confirmed count that does not already include the first one's effect.


-- ── Does a published roster need a new revision? ───────────────────────────
--
-- Only a roster that has actually been published can be *re*-published. Phase 4
-- made `roster_revision` mean "how many times members have been told the
-- roster", so:
--
--   * first_come matches never finalize, and their roster is authoritative the
--     moment somebody joins (F-06) — nothing to revise;
--   * an admin_approval match before finalization has told nobody anything;
--   * an admin_approval match after finalization has, so a cancellation or a
--     promotion is a genuine visible change and advances it once.
--
-- Returning the *new* revision, or NULL when none was needed, lets the callers
-- below key their notifications consistently without repeating the rule.
create or replace function public.advance_roster_revision_if_published(p_match_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revision integer;
begin
  update public.matches m
     set roster_revision = m.roster_revision + 1
   where m.id = p_match_id
     and m.roster_finalized_at is not null
  returning m.roster_revision into v_revision;

  return v_revision;
end;
$$;


-- ── The first waitlisted player who is still eligible ──────────────────────
--
-- F-09 says "the first *eligible* waitlisted player is promoted", so an
-- ineligible candidate is skipped rather than promoted or allowed to stall the
-- queue. Skipped players keep their place: somebody who has not yet accepted a
-- new guideline version may accept it and be promoted next time, and silently
-- dropping them would be a punishment nothing in the product describes.
--
-- Eligibility is re-checked here, at promotion time, rather than trusted from
-- when they joined the waitlist — membership and guideline state both move.
create or replace function public.next_promotable_membership(p_match_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.membership_id
  from public.match_signups s
  join public.league_memberships m on m.id = s.membership_id
  join public.matches mt on mt.id = s.match_id
  where s.match_id = p_match_id
    and s.status = 'waitlisted'
    and m.status = 'active'
    and (
      public.current_required_guideline_version(mt.league_id) is null
      or exists (
        select 1 from public.guideline_acceptances a
        where a.membership_id = s.membership_id
          and a.guideline_version_id =
              public.current_required_guideline_version(mt.league_id)
      )
    )
  order by s.waitlist_position
  limit 1;
$$;


-- ── Promote one waitlisted player into a free slot ─────────────────────────
--
-- Internal. Assumes the match row is already locked and that a slot is free;
-- both callers establish that. Returns the promoted membership, or NULL when
-- nobody was eligible.
--
-- Not granted to any client role: promotion is always a consequence of another
-- operation (a cancellation, or an administrator's explicit decision), never
-- something a caller asks for directly.
create or replace function public.promote_next_waitlisted(
  p_match_id uuid,
  p_actor uuid,
  p_roster_revision integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match public.matches;
  v_membership uuid;
  v_user uuid;
  v_slug text;
begin
  select * into v_match from public.matches m where m.id = p_match_id;

  v_membership := public.next_promotable_membership(p_match_id);
  if v_membership is null then
    return null;
  end if;

  update public.match_signups
     set status = 'confirmed',
         waitlist_position = null,
         selected_by = p_actor,
         selected_at = now()
   where match_id = p_match_id
     and membership_id = v_membership;

  -- Everybody behind them moves up, so the queue stays 1..N.
  perform public.compact_waitlist(p_match_id);

  select m.user_id into v_user
  from public.league_memberships m where m.id = v_membership;
  select l.slug into v_slug from public.leagues l where l.id = v_match.league_id;

  -- One promotion per player per match. This is the notification the whole
  -- automatic mode exists to produce, so it is push-eligible: a spot opening
  -- the evening before a match is exactly the case where the in-app inbox
  -- alone is not enough.
  perform public.create_notification(
    v_user, v_match.league_id, 'waitlist_promotion',
    'You are in: ' || v_match.title,
    'A spot opened and you have it. '
      || to_char(v_match.kickoff_at at time zone v_match.timezone, 'Dy DD Mon HH24:MI')
      || ' at ' || v_match.location_name,
    '/leagues/' || v_slug || '/matches/' || p_match_id::text,
    'waitlist_promotion:' || p_match_id::text || ':' || v_membership::text,
    p_match_id,
    jsonb_build_object('push_eligible', true)
  );

  -- Their outcome now matches what they have been told, so a later
  -- finalize_roster() does not announce it a second time.
  if p_roster_revision is not null then
    update public.match_signups
       set published_status = 'confirmed'
     where match_id = p_match_id and membership_id = v_membership;
  end if;

  return v_membership;
end;
$$;


-- ── Cancel a spot, or withdraw from the waitlist ───────────────────────────
--
-- The Phase 5 withdrawal path, and deliberately distinct from Phase 4's
-- `mark_unavailable()`. That one is the pre-confirmation response — "I have not
-- got a place and I cannot come" — and it notifies nobody because nobody was
-- counting on them. This one releases something the match was relying on.
--
-- `interested` is not accepted here. Phase 4 already implements that exact
-- transition through `mark_unavailable()`, and routing one act through two
-- functions would give it two different statuses depending on which button the
-- interface happened to call.
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

  -- The lock, first, exactly as every Phase 4 capacity function takes it.
  select * into v_match from public.matches m where m.id = p_match_id for update;

  if not found or v_match.published_at is null then
    -- Indistinguishable from a match that does not exist, preserving the
    -- Phase 3/4 anti-enumeration behaviour.
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
  -- returns the standing outcome rather than releasing a second slot,
  -- promoting a second player or sending a second receipt.
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

  -- CLASSIFICATION. Server-side, from the match's own concrete cutoff and the
  -- database clock — never recomputed from a template, and never accepted from
  -- the caller in any form.
  --
  -- A waitlisted player is never late: the late label exists because somebody
  -- the match was counting on dropped out, and a waitlisted player was not
  -- being counted on. Nothing in F-09 extends it to them.
  --
  -- The boundary is inclusive — cancelling *at* the cutoff is on time. Note
  -- this rounds the opposite way from `signup_closes_at`, where Phase 3 treats
  -- `now() >= signup_closes_at` as closed.
  v_late := v_was_confirmed and now() > v_match.cancellation_cutoff_at;
  v_status := case when v_late then 'withdrawn_late' else 'canceled' end;

  update public.match_signups
     set status = v_status,
         canceled_at = now(),
         cancellation_reason = v_reason,
         -- Releasing the place in the same statement that records the
         -- cancellation is what makes "a canceled player stops consuming
         -- capacity" true at the moment of commit rather than eventually.
         waitlist_position = null,
         selected_by = null,
         selected_at = null
   where match_id = p_match_id and membership_id = v_membership;

  -- Whoever was behind them in the queue moves up. Runs for a confirmed
  -- canceller too: harmless, and it keeps the one call site.
  perform public.compact_waitlist(p_match_id);

  select l.slug into v_slug from public.leagues l where l.id = v_match.league_id;

  -- A published roster that visibly changes gets a new revision. An unpublished
  -- one has told nobody anything, so there is nothing to revise.
  v_revision := public.advance_roster_revision_if_published(p_match_id);

  if v_revision is not null then
    update public.match_signups
       set published_status = v_status
     where match_id = p_match_id and membership_id = v_membership;
  end if;

  -- ── The freed slot ──────────────────────────────────────────────────────
  if v_was_confirmed then
    if v_match.waitlist_mode = 'automatic' then
      -- F-09: automatic mode requires no administrator action, so the
      -- promotion happens in this transaction rather than being queued for
      -- somebody to approve.
      v_promoted := public.promote_next_waitlisted(p_match_id, v_actor, v_revision);
    else
      -- Administrator-controlled: the spot stays open and somebody is told.
      -- Promoting silently here is exactly what this mode exists to prevent.
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

  -- ── Receipt ─────────────────────────────────────────────────────────────
  -- The classification is in the key, so a player who is re-added by an
  -- administrator and cancels again is told again.
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

  -- ── Late-cancellation alert ─────────────────────────────────────────────
  if v_late then
    select m.user_id into v_admin
    from public.league_memberships m
    where m.league_id = v_match.league_id
      and m.role = 'league_admin'
      and m.status = 'active';

    if v_admin is not null then
      -- Deliberately says "withdrew late", not "no-show". A late cancellation
      -- is a withdrawal after the cutoff and nothing more; whether it becomes a
      -- no-show is an attendance judgement Phase 7 owns, and pre-judging it
      -- here would put a disciplinary label on somebody who turned up.
      --
      -- The reason the player gave is NOT included. It is free text about a
      -- person, and this notification's body is a candidate for a lock screen.
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

  -- ── Audit ───────────────────────────────────────────────────────────────
  -- Actor from auth.uid(), membership id rather than a name, and the reason
  -- recorded only as a boolean: audit rows are readable by every future
  -- administrator of the league, and why somebody could not play is theirs.
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


-- ── Administrator promotion ────────────────────────────────────────────────
--
-- The administrator-controlled counterpart. `p_membership_id` is optional: with
-- no target the recommended candidate is promoted, which is the ordinary case
-- and keeps the interface's primary action a single press.
--
-- Choosing somebody other than the recommendation requires a reason. F-09 says
-- the administrator "may promote a different eligible player with an audit
-- note", so the note is a condition of the override rather than decoration.
create or replace function public.promote_waitlisted_player(
  p_match_id uuid,
  p_membership_id uuid default null,
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
  v_recommended uuid;
  v_target uuid;
  v_signup public.match_signups;
  v_membership public.league_memberships;
  v_confirmed integer;
  v_revision integer;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_user uuid;
  v_slug text;
  v_outcome public.signup_outcome;
begin
  v_match := public.lock_match_as_admin(p_match_id);

  v_recommended := public.next_promotable_membership(p_match_id);
  v_target := coalesce(p_membership_id, v_recommended);

  if v_target is null then
    raise exception 'WAITLIST_CONFLICT: nobody eligible is waiting' using errcode = 'P0001';
  end if;

  -- Overriding the recommendation is allowed, but it has to be explained.
  if v_target is distinct from v_recommended and v_reason is null then
    raise exception
      'SIGNUP_DECISION_INVALID: promoting out of order needs a reason'
      using errcode = 'P0001';
  end if;

  -- Capacity is re-checked under the lock, so this cannot overfill a match
  -- whose last slot was taken while the page was open.
  v_confirmed := public.match_confirmed_count(p_match_id);
  if v_confirmed >= v_match.capacity then
    raise exception 'CAPACITY_EXCEEDED: this match is already at capacity'
      using errcode = 'P0001';
  end if;

  select * into v_signup
  from public.match_signups s
  where s.match_id = p_match_id and s.membership_id = v_target;

  if not found or v_signup.status <> 'waitlisted' then
    raise exception 'WAITLIST_CONFLICT: that player is not on the waitlist'
      using errcode = 'P0001';
  end if;

  -- Scoped by league, so a membership from another tenant is simply not found.
  select * into v_membership
  from public.league_memberships m
  where m.id = v_target and m.league_id = v_match.league_id;

  if not found then
    raise exception 'MEMBERSHIP_REQUIRED: no such member of this league'
      using errcode = '42501';
  end if;

  if v_membership.status <> 'active' then
    raise exception 'MEMBERSHIP_INACTIVE: that member is not active in this league'
      using errcode = '42501';
  end if;

  if public.current_required_guideline_version(v_match.league_id) is not null
     and not exists (
       select 1 from public.guideline_acceptances a
       where a.membership_id = v_target
         and a.guideline_version_id =
             public.current_required_guideline_version(v_match.league_id)
     )
  then
    raise exception
      'GUIDELINES_NOT_ACCEPTED: that member has not accepted the current guidelines'
      using errcode = '42501';
  end if;

  update public.match_signups
     set status = 'confirmed',
         waitlist_position = null,
         selected_by = v_actor,
         selected_at = now(),
         override_reason = case when v_target is distinct from v_recommended
                                then v_reason else override_reason end
   where match_id = p_match_id and membership_id = v_target;

  perform public.compact_waitlist(p_match_id);

  v_revision := public.advance_roster_revision_if_published(p_match_id);
  if v_revision is not null then
    update public.match_signups
       set published_status = 'confirmed'
     where match_id = p_match_id and membership_id = v_target;
  end if;

  select m.user_id into v_user
  from public.league_memberships m where m.id = v_target;
  select l.slug into v_slug from public.leagues l where l.id = v_match.league_id;

  perform public.create_notification(
    v_user, v_match.league_id, 'waitlist_promotion',
    'You are in: ' || v_match.title,
    'A spot opened and the administrator has given it to you. '
      || to_char(v_match.kickoff_at at time zone v_match.timezone, 'Dy DD Mon HH24:MI')
      || ' at ' || v_match.location_name,
    '/leagues/' || v_slug || '/matches/' || p_match_id::text,
    'waitlist_promotion:' || p_match_id::text || ':' || v_target::text,
    p_match_id,
    jsonb_build_object('push_eligible', true)
  );

  -- The override reason is administrator-only: recorded on the signup row and
  -- in the audit event, never in the promoted player's notification.
  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match_signup', p_match_id, 'roster.promoted',
    jsonb_build_object('membership_id', v_target,
                       'status', 'waitlisted',
                       'waitlist_position', v_signup.waitlist_position),
    jsonb_build_object('membership_id', v_target,
                       'status', 'confirmed',
                       'followed_recommendation', v_target is not distinct from v_recommended,
                       'roster_revision', v_revision),
    v_reason
  );

  v_outcome := ('confirmed', null);
  return v_outcome;
end;
$$;


-- ── The administrator's view of an open slot ───────────────────────────────
--
-- Who the roster workspace should offer to promote, and how many places are
-- free. Administrator-only, and it returns a membership rather than a name so
-- the caller still goes through the workspace projection for anything human.
create or replace function public.match_replacement_state(p_match_id uuid)
returns table (
  open_spots integer,
  waitlisted integer,
  recommended_membership_id uuid,
  waitlist_mode public.waitlist_mode
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    greatest(0, mt.capacity - public.match_confirmed_count(mt.id))::integer,
    (select count(*)::integer from public.match_signups s
      where s.match_id = mt.id and s.status = 'waitlisted'),
    public.next_promotable_membership(mt.id),
    mt.waitlist_mode
  from public.matches mt
  where mt.id = p_match_id
    and public.is_league_admin(mt.league_id);
$$;


-- ══ Grants ═════════════════════════════════════════════════════════════════
-- PostgreSQL grants EXECUTE to PUBLIC on every new function; 20260805030900
-- records what that cost the first time it was missed.

revoke execute on function public.advance_roster_revision_if_published(uuid) from public;
revoke execute on function public.next_promotable_membership(uuid) from public;
revoke execute on function public.promote_next_waitlisted(uuid, uuid, integer) from public;
revoke execute on function public.cancel_spot(uuid, text) from public;
revoke execute on function public.promote_waitlisted_player(uuid, uuid, text) from public;
revoke execute on function public.match_replacement_state(uuid) from public;

-- Internal consequences of another operation, never called directly by a client.
grant execute on function public.advance_roster_revision_if_published(uuid) to service_role;
grant execute on function public.next_promotable_membership(uuid) to service_role;
grant execute on function public.promote_next_waitlisted(uuid, uuid, integer) to service_role;

-- Authorization is inside each function, against auth.uid(), not at the grant.
grant execute on function public.cancel_spot(uuid, text) to authenticated, service_role;
grant execute on function public.promote_waitlisted_player(uuid, uuid, text)
  to authenticated, service_role;
grant execute on function public.match_replacement_state(uuid) to authenticated, service_role;

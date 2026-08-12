-- Matchday — Phase 7L/7M/7N
-- Suspending, removing and reactivating a member — and what that does to the
-- matches they were already signed up for.
--
-- THE HARD PART IS THE CASCADE, and no approved document defines it. F-12 says
-- an administrator "may manually set membership to suspended or removed with a
-- reason and optional end date" and stops there. So the rule here is the
-- smallest one that leaves no impossible state behind:
--
--   * an inactive member stops consuming future capacity;
--   * they stop being eligible for promotion;
--   * they disappear from future player-visible rosters and teams;
--   * everything else about those matches keeps working.
--
-- WHAT IT DELIBERATELY DOES NOT DO. It never writes `canceled` or
-- `withdrawn_late`, never sets `cancellation_reason`, and never sends a
-- cancellation receipt. Those all say "this player withdrew", and they did not
-- — an administrator removed them. Faking a player cancellation would put words
-- in somebody's mouth and would corrupt the Phase 5 late-cancellation
-- classification, which exists to distinguish a person who let the team down
-- from one who did not. The signup becomes `not_selected`, which is what an
-- administrator deciding somebody is not playing actually means.


-- ── Removing one member from one future match ──────────────────────────────
--
-- Internal. Assumes the match row is already locked by the caller, which is what
-- keeps this ordered against joins, cancellations and team publication.
create or replace function public.withdraw_membership_from_match(
  p_match_id uuid,
  p_membership_id uuid,
  p_actor uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match public.matches;
  v_signup public.match_signups;
  v_was_confirmed boolean;
  v_roster_revision integer;
  v_team_revision integer;
  v_slug text;
  v_recipient record;
begin
  select * into v_match from public.matches m where m.id = p_match_id;

  select * into v_signup
  from public.match_signups s
  where s.match_id = p_match_id and s.membership_id = p_membership_id;

  if not found or v_signup.status in ('canceled', 'withdrawn_late', 'not_selected') then
    return;
  end if;

  v_was_confirmed := public.signup_consumes_capacity(v_signup.status);

  -- `not_selected`, not `canceled`: an administrator decided they are not
  -- playing. `confirmed_at` is untouched, so if the match has already been
  -- played they still appear in its attendance register.
  update public.match_signups
     set status = 'not_selected',
         waitlist_position = null,
         selected_by = p_actor,
         selected_at = now()
   where match_id = p_match_id and membership_id = p_membership_id;

  delete from public.match_team_assignments
   where match_id = p_match_id and membership_id = p_membership_id;

  perform public.compact_waitlist(p_match_id);

  select l.slug into v_slug from public.leagues l where l.id = v_match.league_id;

  v_roster_revision := public.advance_roster_revision_if_published(p_match_id);
  if v_roster_revision is not null then
    update public.match_signups
       set published_status = 'not_selected'
     where match_id = p_match_id and membership_id = p_membership_id;
  end if;

  -- The published teams, kept honest exactly as a cancellation keeps them:
  -- a new snapshot without them, and its own revision.
  v_team_revision := public.remove_from_published_teams(p_match_id, p_membership_id, p_actor);

  if v_was_confirmed and v_match.waitlist_mode = 'automatic' then
    perform public.promote_next_waitlisted(p_match_id, p_actor, v_roster_revision);
  end if;

  if v_team_revision is not null then
    for v_recipient in
      select m.user_id, s.membership_id
      from public.match_signups s
      join public.league_memberships m on m.id = s.membership_id
      where s.match_id = p_match_id
        and public.signup_consumes_capacity(s.status)
        and m.status = 'active'
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
end;
$$;


-- ── Changing a membership's status ─────────────────────────────────────────
--
-- The one path for suspend, remove and reactivate.
create or replace function public.set_membership_status(
  p_membership_id uuid,
  p_status public.membership_status,
  p_reason text default null,
  p_suspended_until timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_membership public.league_memberships;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_match record;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  select * into v_membership
  from public.league_memberships m where m.id = p_membership_id;

  -- Not found and not-your-league answer identically, so a guessed id cannot
  -- confirm that a membership exists in a league the caller cannot see.
  if not found or not public.is_league_admin(v_membership.league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  if p_status not in ('active', 'suspended', 'removed') then
    raise exception 'VALIDATION_FAILED: % is not a status an administrator sets', p_status
      using errcode = 'P0001';
  end if;

  -- THE SOLE ADMINISTRATOR IS PROTECTED HERE AS WELL AS BY THE DEFERRED
  -- CONSTRAINT. The Phase 1 trigger would refuse this at COMMIT anyway, but it
  -- reports a cardinality violation; an administrator who suspends themselves
  -- deserves to be told to transfer administration first.
  if v_membership.role = 'league_admin' and p_status <> 'active' then
    raise exception
      'ADMIN_TRANSFER_INVALID: transfer administration before suspending or removing this member'
      using errcode = 'P0001';
  end if;

  if p_status in ('suspended', 'removed') and v_reason is null then
    raise exception 'VALIDATION_FAILED: a reason is required' using errcode = 'P0001';
  end if;

  -- `suspended_until` is informational. Nothing expires it — there is no job
  -- that reactivates anybody, and adding one would let a member silently regain
  -- access with no administrator deciding it. Reactivation stays deliberate.
  update public.league_memberships
     set status = p_status,
         status_reason = v_reason,
         suspended_until = case when p_status = 'suspended' then p_suspended_until end
   where id = p_membership_id;

  -- ── The cascade ─────────────────────────────────────────────────────────
  --
  -- Only for future matches, and only when the member is losing access.
  -- Attendance for matches already played is history and stays untouched.
  --
  -- Ordered by id so two concurrent status changes touching overlapping matches
  -- take the locks in the same sequence and cannot deadlock.
  if p_status in ('suspended', 'removed') then
    for v_match in
      select m.id
      from public.matches m
      join public.match_signups s on s.match_id = m.id
      where m.league_id = v_membership.league_id
        and s.membership_id = p_membership_id
        and s.status in ('interested', 'confirmed', 'waitlisted')
        and m.status not in ('canceled', 'completed')
        and m.kickoff_at > now()
      order by m.id
      for update of m
    loop
      perform public.withdraw_membership_from_match(v_match.id, p_membership_id, v_actor);
    end loop;
  end if;

  -- NO AUDIT CALL HERE. `league_memberships_audit_change` has recorded
  -- `membership.status_changed` since Phase 1 for any authenticated change by
  -- any path, and logging again would put two rows in the trail for one
  -- decision. The reason reaches that event through `status_reason`, which the
  -- UPDATE above has already written — see the trigger amendment below.
  return p_membership_id;
end;
$$;


-- ── The audit event, now with the reason ───────────────────────────────────
--
-- The Phase 1 trigger is the single record of a membership status change,
-- whichever path made it. Phase 7 adds a reason to that decision, so the trigger
-- carries it — rather than `set_membership_status()` writing a second event,
-- which would mean two rows for one decision and no reason at all on the row a
-- future path writes.
--
-- The reason is attached only to a status change. A role change has its own
-- reason, and reusing whatever `status_reason` happened to be left from an
-- earlier suspension would attribute the wrong justification to it.
create or replace function public.league_memberships_audit_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_action text;
  v_before jsonb;
  v_after jsonb;
  v_reason text;
begin
  if v_actor is null then
    return null;
  end if;

  if tg_op = 'INSERT' then
    v_action := 'membership.created';
    v_before := null;
    v_after := jsonb_build_object('role', new.role, 'status', new.status);
  else
    if new.role is distinct from old.role then
      v_action := 'membership.role_changed';
    elsif new.status is distinct from old.status then
      v_action := 'membership.status_changed';
      v_reason := new.status_reason;
      v_after := jsonb_build_object('suspended_until', new.suspended_until);
    else
      return null;
    end if;

    v_before := jsonb_build_object('role', old.role, 'status', old.status);
    v_after := coalesce(v_after, '{}'::jsonb)
               || jsonb_build_object('role', new.role, 'status', new.status);
  end if;

  perform public.log_audit_event(
    new.league_id, v_actor, 'league_membership', new.id, v_action,
    v_before, v_after, v_reason);

  return null;
end;
$$;


-- ══ Grants ═════════════════════════════════════════════════════════════════

revoke execute on function public.withdraw_membership_from_match(uuid, uuid, uuid) from public;
revoke execute on function public.set_membership_status(
  uuid, public.membership_status, text, timestamptz) from public;

grant execute on function public.withdraw_membership_from_match(uuid, uuid, uuid) to service_role;
grant execute on function public.set_membership_status(
  uuid, public.membership_status, text, timestamptz) to authenticated, service_role;

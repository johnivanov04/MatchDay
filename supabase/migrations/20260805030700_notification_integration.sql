-- Matchday — Phase 3C
-- Wires domain events to canonical notifications.
--
-- The Phase 2 functions are recreated here with notification fanout added and
-- NOTHING ELSE CHANGED. Their membership rules, authorization checks,
-- idempotency behaviour, error codes and audit events are byte-identical to
-- 20260803020200; the Phase 2 test suite still passes unmodified, which is the
-- check that this is true.
--
-- Fanout lives inside each function, in the same transaction as the domain
-- change. A notification that exists without its cause, or a cause without its
-- notification, would both be worse than either failing outright.

-- ── Join request submitted → the league administrator ──────────────────────
create or replace function public.request_to_join_league(
  p_league_id uuid,
  p_message text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_request_id uuid;
  v_slug text;
  v_admin uuid;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.leagues l
    where l.id = p_league_id
      and l.visibility = 'searchable'::public.league_visibility
  ) then
    raise exception 'LEAGUE_NOT_FOUND: no searchable league with that identifier'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.league_memberships m
    where m.league_id = p_league_id
      and m.user_id = v_actor
      and m.status <> 'removed'::public.membership_status
  ) then
    raise exception 'MEMBERSHIP_EXISTS: you already belong to this league'
      using errcode = 'P0001';
  end if;

  -- Idempotent: asking twice returns the same pending request rather than
  -- failing or creating a second one. It also, deliberately, does not notify
  -- the administrator a second time.
  select r.id into v_request_id
  from public.league_join_requests r
  where r.league_id = p_league_id
    and r.user_id = v_actor
    and r.status = 'pending'::public.join_request_status;

  if v_request_id is not null then
    return v_request_id;
  end if;

  insert into public.league_join_requests (league_id, user_id, status, message)
  values (
    p_league_id, v_actor, 'pending',
    nullif(btrim(coalesce(p_message, '')), '')
  )
  returning id into v_request_id;

  perform public.log_audit_event(
    p_league_id, v_actor, 'league_join_request', v_request_id,
    'join_request.submitted', null, jsonb_build_object('status', 'pending'), null
  );

  select l.slug into v_slug from public.leagues l where l.id = p_league_id;

  select m.user_id into v_admin
  from public.league_memberships m
  where m.league_id = p_league_id
    and m.role = 'league_admin'::public.league_role
    and m.status = 'active'::public.membership_status;

  if v_admin is not null then
    perform public.create_notification(
      v_admin, p_league_id, 'join_request_submitted',
      'New request to join',
      'Someone has asked to join your league.',
      '/leagues/' || v_slug || '/members',
      'join_request_submitted:' || v_request_id::text || ':' || v_admin::text,
      null,
      '{}'::jsonb
    );
  end if;

  return v_request_id;
end;
$$;


-- ── Join request decided → the person who asked ────────────────────────────
create or replace function public.decide_join_request(
  p_request_id uuid,
  p_approve boolean,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_request public.league_join_requests;
  v_membership_id uuid;
  v_slug text;
  v_league_name text;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  select * into v_request
  from public.league_join_requests r
  where r.id = p_request_id;

  -- A request in another tenant is reported as though it does not exist.
  if not found or not public.is_league_admin(v_request.league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  if v_request.status <> 'pending'::public.join_request_status then
    -- Already decided. Return the membership if this was an approval, so a
    -- repeated call is a no-op rather than an error — and, as a consequence,
    -- notifies nobody a second time.
    select m.id into v_membership_id
    from public.league_memberships m
    where m.league_id = v_request.league_id and m.user_id = v_request.user_id;
    return v_membership_id;
  end if;

  select l.slug, l.name into v_slug, v_league_name
  from public.leagues l where l.id = v_request.league_id;

  if p_approve then
    insert into public.league_memberships as m (league_id, user_id, role, status)
    values (v_request.league_id, v_request.user_id, 'player', 'active')
    on conflict (league_id, user_id) do update
      set status = 'active'::public.membership_status,
          -- Re-admitting a previously removed administrator makes them an
          -- ordinary member; the league already has its single administrator.
          role = case
                   when m.role = 'league_admin'::public.league_role
                        and m.status = 'removed'::public.membership_status
                   then 'player'::public.league_role
                   else m.role
                 end
    returning m.id into v_membership_id;

    update public.league_join_requests
       set status = 'approved', decided_by = v_actor, decided_at = now(),
           decision_note = nullif(btrim(coalesce(p_note, '')), '')
     where id = p_request_id;

    perform public.log_audit_event(
      v_request.league_id, v_actor, 'league_join_request', p_request_id,
      'join_request.approved',
      jsonb_build_object('status', 'pending'),
      jsonb_build_object('status', 'approved', 'membership_id', v_membership_id),
      nullif(btrim(coalesce(p_note, '')), '')
    );

    perform public.create_notification(
      v_request.user_id, v_request.league_id, 'join_request_approved',
      'You have joined ' || v_league_name,
      'Your request to join was approved.',
      '/leagues/' || v_slug || '/matches',
      'join_request_approved:' || p_request_id::text || ':' || v_request.user_id::text,
      null,
      jsonb_build_object('push_eligible', true)
    );
  else
    update public.league_join_requests
       set status = 'rejected', decided_by = v_actor, decided_at = now(),
           decision_note = nullif(btrim(coalesce(p_note, '')), '')
     where id = p_request_id;

    perform public.log_audit_event(
      v_request.league_id, v_actor, 'league_join_request', p_request_id,
      'join_request.rejected',
      jsonb_build_object('status', 'pending'),
      jsonb_build_object('status', 'rejected'),
      nullif(btrim(coalesce(p_note, '')), '')
    );

    -- Deep-links to discovery, not to the league: a rejected applicant has no
    -- membership and must not be sent at a member-only page.
    perform public.create_notification(
      v_request.user_id, v_request.league_id, 'join_request_rejected',
      'Request not approved',
      'Your request to join ' || v_league_name || ' was not approved.',
      '/leagues/discover',
      'join_request_rejected:' || p_request_id::text || ':' || v_request.user_id::text,
      null,
      jsonb_build_object('push_eligible', true)
    );
  end if;

  return v_membership_id;
end;
$$;


-- ── Invitation redeemed → the league administrator ─────────────────────────
create or replace function public.redeem_league_invite(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_invite public.league_invites;
  v_membership public.league_memberships;
  v_membership_id uuid;
  v_slug text;
  v_admin uuid;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  if not exists (select 1 from public.profiles p where p.id = v_actor) then
    raise exception 'PROFILE_INCOMPLETE: complete your profile before joining a league'
      using errcode = 'P0001';
  end if;

  if p_token is null or btrim(p_token) = '' then
    raise exception 'INVITE_INVALID: that invitation link is not valid'
      using errcode = 'P0001';
  end if;

  select * into v_invite
  from public.league_invites i
  where i.token_hash = sha256(convert_to(btrim(p_token), 'UTF8'));

  if not found
     or v_invite.revoked_at is not null
     or v_invite.expires_at <= now()
     or (v_invite.max_uses is not null and v_invite.use_count >= v_invite.max_uses)
  then
    raise exception 'INVITE_INVALID: that invitation link is not valid'
      using errcode = 'P0001';
  end if;

  select * into v_membership
  from public.league_memberships m
  where m.league_id = v_invite.league_id and m.user_id = v_actor;

  -- Idempotent: someone who already belongs gets their existing membership and
  -- the invitation's use count is NOT spent. No notification either — nothing
  -- happened.
  if found and v_membership.status <> 'removed'::public.membership_status then
    return jsonb_build_object(
      'league_id', v_invite.league_id,
      'membership_id', v_membership.id,
      'status', v_membership.status,
      'joined', false
    );
  end if;

  insert into public.league_memberships as m (league_id, user_id, role, status)
  values (v_invite.league_id, v_actor, 'player', v_invite.grants_status)
  on conflict (league_id, user_id) do update
    set status = v_invite.grants_status,
        role = case
                 when m.role = 'league_admin'::public.league_role
                 then 'player'::public.league_role
                 else m.role
               end
  returning m.id into v_membership_id;

  -- Counted only when a membership was actually granted. The CHECK constraint
  -- `league_invites_within_use_limit` makes overrunning the limit impossible
  -- even under concurrency.
  update public.league_invites
     set use_count = use_count + 1
   where id = v_invite.id;

  perform public.log_audit_event(
    v_invite.league_id, v_actor, 'league_invite', v_invite.id, 'invite.redeemed',
    null,
    jsonb_build_object('membership_id', v_membership_id,
                       'status', v_invite.grants_status),
    null
  );

  select l.slug into v_slug from public.leagues l where l.id = v_invite.league_id;

  select m.user_id into v_admin
  from public.league_memberships m
  where m.league_id = v_invite.league_id
    and m.role = 'league_admin'::public.league_role
    and m.status = 'active'::public.membership_status;

  -- Keyed on the membership, so one notification per person who joins, however
  -- many times the link is opened.
  if v_admin is not null and v_admin <> v_actor then
    perform public.create_notification(
      v_admin, v_invite.league_id, 'league_invitation_accepted',
      'Someone joined by invitation',
      'A new member accepted an invitation link.',
      '/leagues/' || v_slug || '/members',
      'league_invitation_accepted:' || v_membership_id::text || ':' || v_admin::text,
      null,
      '{}'::jsonb
    );
  end if;

  return jsonb_build_object(
    'league_id', v_invite.league_id,
    'membership_id', v_membership_id,
    'status', v_invite.grants_status,
    'joined', true
  );
end;
$$;


-- ── Guideline published → every active member ──────────────────────────────
create or replace function public.publish_guideline_version(p_guideline_version_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_version public.guideline_versions;
  v_slug text;
  v_league_name text;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  select * into v_version
  from public.guideline_versions v
  where v.id = p_guideline_version_id;

  if not found or not public.is_league_admin(v_version.league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  if v_version.archived_at is not null then
    raise exception 'GUIDELINE_ARCHIVED: an archived version cannot be published'
      using errcode = 'P0001';
  end if;

  -- Already published: nothing changes, no audit event, and nobody is told
  -- twice.
  if v_version.published_at is not null then
    return v_version.id;
  end if;

  update public.guideline_versions
     set published_at = now()
   where id = p_guideline_version_id;

  perform public.log_audit_event(
    v_version.league_id, v_actor, 'guideline_version', p_guideline_version_id,
    'guideline_version.published',
    jsonb_build_object('published', false),
    jsonb_build_object('published', true,
                       'version_label', v_version.version_label,
                       'requires_acceptance', v_version.requires_acceptance),
    null
  );

  select l.slug, l.name into v_slug, v_league_name
  from public.leagues l where l.id = v_version.league_id;

  -- Exactly one event per publication. The "acceptance required" variant is an
  -- action the member must take and is push-eligible; the plain "published"
  -- variant is informational and stays in the app.
  if v_version.requires_acceptance then
    perform public.notify_league_members(
      v_version.league_id, 'guideline_acceptance_required',
      'Action needed: ' || v_league_name || ' guidelines',
      'New guidelines need your acceptance before you can sign up for matches.',
      '/leagues/' || v_slug || '/guidelines',
      'guideline_acceptance_required:' || p_guideline_version_id::text,
      null, v_actor,
      jsonb_build_object('push_eligible', true)
    );
  else
    perform public.notify_league_members(
      v_version.league_id, 'guideline_version_published',
      v_league_name || ' guidelines updated',
      'The league has published an updated set of guidelines.',
      '/leagues/' || v_slug || '/guidelines',
      'guideline_version_published:' || p_guideline_version_id::text,
      null, v_actor,
      '{}'::jsonb
    );
  end if;

  return v_version.id;
end;
$$;


-- ── Match published / changed / canceled → every active member ─────────────

create or replace function public.publish_match(p_match_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_published_at timestamptz := now();
  v_slug text;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  select * into v_match from public.matches m where m.id = p_match_id;

  if not found or not public.is_league_admin(v_match.league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  -- The whole reason publication is idempotent by state: this is the event that
  -- creates one notification per member, and a resubmitted form must not
  -- produce a second round.
  if v_match.status = 'open' then
    return v_match.id;
  end if;

  if v_match.status <> 'draft' then
    raise exception 'MATCH_NOT_OPEN: only a draft match can be published'
      using errcode = 'P0001';
  end if;

  update public.matches
     set status = 'open',
         published_at = v_published_at,
         priority_window_ends_at = case
           when v_match.priority_window is null then null
           else least(v_published_at + v_match.priority_window, v_match.signup_closes_at)
         end
   where id = p_match_id;

  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match', p_match_id, 'match.published',
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'open', 'kickoff_at', v_match.kickoff_at),
    null
  );

  select l.slug into v_slug from public.leagues l where l.id = v_match.league_id;

  perform public.notify_league_members(
    v_match.league_id, 'match_published',
    'New match: ' || v_match.title,
    to_char(v_match.kickoff_at at time zone v_match.timezone, 'Dy DD Mon HH24:MI')
      || ' at ' || v_match.location_name,
    '/leagues/' || v_slug || '/matches/' || p_match_id::text,
    'match_published:' || p_match_id::text,
    p_match_id, v_actor,
    jsonb_build_object('push_eligible', true)
  );

  return v_match.id;
end;
$$;


create or replace function public.cancel_match(p_match_id uuid, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_slug text;
  v_was_published boolean;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  select * into v_match from public.matches m where m.id = p_match_id;

  if not found or not public.is_league_admin(v_match.league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  if v_match.status = 'canceled' then
    return v_match.id;
  end if;

  v_was_published := v_match.status <> 'draft';

  update public.matches
     set status = 'canceled',
         canceled_at = now(),
         cancellation_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         published_at = coalesce(v_match.published_at, now())
   where id = p_match_id;

  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match', p_match_id, 'match.canceled',
    jsonb_build_object('status', v_match.status),
    jsonb_build_object('status', 'canceled'),
    nullif(btrim(coalesce(p_reason, '')), '')
  );

  -- Cancelling a draft tells nobody: members never saw it. Only a match that
  -- was actually open produces a cancellation alert.
  if v_was_published then
    select l.slug into v_slug from public.leagues l where l.id = v_match.league_id;

    perform public.notify_league_members(
      v_match.league_id, 'match_canceled',
      'Canceled: ' || v_match.title,
      to_char(v_match.kickoff_at at time zone v_match.timezone, 'Dy DD Mon HH24:MI')
        || ' will not go ahead.',
      '/leagues/' || v_slug || '/matches/' || p_match_id::text,
      'match_canceled:' || p_match_id::text,
      p_match_id, v_actor,
      jsonb_build_object('push_eligible', true)
    );
  end if;

  return v_match.id;
end;
$$;


create or replace function public.update_published_match(
  p_match_id uuid,
  p_title text,
  p_match_date date,
  p_arrival_time time,
  p_kickoff_time time,
  p_end_time time,
  p_location_name text,
  p_capacity integer,
  p_min_players integer,
  p_team_count integer,
  p_location_map_url text default null,
  p_public_notes text default null,
  p_change_note text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_timezone text;
  v_arrival timestamptz;
  v_kickoff timestamptz;
  v_end timestamptz;
  v_signup_lead interval;
  v_cancel_lead interval;
  v_roster_lead interval;
  v_revision integer;
  v_slug text;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  select * into v_match from public.matches m where m.id = p_match_id;

  if not found or not public.is_league_admin(v_match.league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  if v_match.status <> 'open' then
    raise exception 'MATCH_NOT_OPEN: only an open match can be edited this way'
      using errcode = 'P0001';
  end if;

  v_timezone := v_match.timezone;

  v_signup_lead := v_match.kickoff_at - v_match.signup_closes_at;
  v_cancel_lead := v_match.kickoff_at - v_match.cancellation_cutoff_at;
  v_roster_lead := case when v_match.roster_publish_target_at is null then null
                        else v_match.kickoff_at - v_match.roster_publish_target_at end;

  v_arrival := (p_match_date + p_arrival_time) at time zone v_timezone;
  v_kickoff := (p_match_date + p_kickoff_time) at time zone v_timezone;
  v_end := (p_match_date + p_end_time) at time zone v_timezone;

  update public.matches
     set title = btrim(p_title),
         match_date = p_match_date,
         arrival_at = v_arrival,
         kickoff_at = v_kickoff,
         end_at = v_end,
         location_name = btrim(p_location_name),
         location_map_url = nullif(btrim(coalesce(p_location_map_url, '')), ''),
         capacity = p_capacity,
         min_players = p_min_players,
         team_count = p_team_count,
         public_notes = nullif(btrim(coalesce(p_public_notes, '')), ''),
         signup_closes_at = v_kickoff - v_signup_lead,
         cancellation_cutoff_at = v_kickoff - v_cancel_lead,
         roster_publish_target_at = case when v_roster_lead is null then null
                                         else v_kickoff - v_roster_lead end,
         priority_window_ends_at = case
           when v_match.priority_window_ends_at is null then null
           else least(v_match.priority_window_ends_at, v_kickoff - v_signup_lead)
         end,
         revision = v_match.revision + 1
   where id = p_match_id
  returning revision into v_revision;

  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match', p_match_id, 'match.updated',
    jsonb_build_object('title', v_match.title, 'kickoff_at', v_match.kickoff_at,
                       'capacity', v_match.capacity, 'revision', v_match.revision),
    jsonb_build_object('title', btrim(p_title), 'kickoff_at', v_kickoff,
                       'capacity', p_capacity, 'revision', v_revision),
    nullif(btrim(coalesce(p_change_note, '')), '')
  );

  select l.slug into v_slug from public.leagues l where l.id = v_match.league_id;

  -- The revision is part of the key, so this change notifies once while a
  -- retried submission of the same edit does not — and a genuinely new edit
  -- still gets through.
  perform public.notify_league_members(
    v_match.league_id, 'match_changed',
    'Updated: ' || btrim(p_title),
    to_char(v_kickoff at time zone v_timezone, 'Dy DD Mon HH24:MI')
      || ' at ' || btrim(p_location_name),
    '/leagues/' || v_slug || '/matches/' || p_match_id::text,
    'match_changed:' || p_match_id::text || ':' || v_revision::text,
    p_match_id, v_actor,
    jsonb_build_object('push_eligible', true)
  );

  return v_revision;
end;
$$;

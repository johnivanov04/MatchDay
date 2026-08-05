-- Matchday — Phase 2
-- League management operations.
--
-- Every function here is SECURITY DEFINER with `search_path = ''`, and every
-- one derives the actor from `auth.uid()` — never from a parameter. A caller
-- can say *which* league or request to act on; they can never say *who* they
-- are or what role they hold. That is the database-level half of "never
-- authorize from a client-provided role or user ID"; the server actions repeat
-- the check independently.
--
-- These exist as functions rather than as INSERT policies because each one has
-- to consult something the caller is deliberately not allowed to read: whether
-- a league is searchable, whether an invite digest matches, whether a
-- membership already exists in a tenant they are not part of. A policy can
-- filter rows; it cannot make that kind of decision.
--
-- Error convention:
--   42501  authorization failure   (AUTH_REQUIRED, NOT_LEAGUE_ADMIN, ...)
--   P0001  domain/state failure    (LEAGUE_NOT_FOUND, INVITE_INVALID, ...)
-- Messages start with the stable domain code from 02 §21 so the application can
-- map them without pattern-matching on prose.


-- ── Internal audit writer ──────────────────────────────────────────────────
-- public.record_audit_event() requires the caller to be a league administrator,
-- which is right for administrator actions but structurally cannot express
-- "this player redeemed an invitation". This helper has no such check, so it is
-- kept internal: EXECUTE is revoked from anon and authenticated in the grants
-- migration, and only the SECURITY DEFINER functions below (which run as the
-- owner) can reach it.
create or replace function public.log_audit_event(
  p_league_id uuid,
  p_actor uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_action text,
  p_before jsonb default null,
  p_after jsonb default null,
  p_reason text default null
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_events (
    league_id, actor_user_id, entity_type, entity_id, action,
    before_data, after_data, reason
  )
  values (
    p_league_id, p_actor, p_entity_type, p_entity_id, p_action,
    p_before, p_after, p_reason
  )
  returning id;
$$;


-- ── Create a league ────────────────────────────────────────────────────────
-- The league row and its administrator membership are inserted in one
-- statement, hence one transaction. That is mandatory, not stylistic: the
-- deferred constraint trigger from Phase 1 rejects any league that reaches
-- COMMIT without exactly one active administrator, so two separate statements
-- could never succeed.
--
-- `visibility` is not a parameter. New leagues are private (PRD §6); making a
-- league searchable is a separate, audited settings change.
create or replace function public.create_league(
  p_name text,
  p_slug text,
  p_general_area text,
  p_timezone text,
  p_sport_label text,
  p_description text,
  p_default_capacity integer,
  p_default_min_players integer default 0,
  p_default_selection_mode public.selection_mode default 'first_come',
  p_default_waitlist_mode public.waitlist_mode default 'automatic',
  p_default_team_count integer default 2,
  p_default_location text default null,
  p_typical_schedule text default null,
  p_gender_field_enabled boolean default false,
  p_goalkeeper_field_enabled boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_league_id uuid;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  -- A league is owned by a person, so that person must have completed a
  -- profile. This also guarantees the created_by foreign key resolves.
  if not exists (select 1 from public.profiles p where p.id = v_actor) then
    raise exception 'PROFILE_INCOMPLETE: complete your profile before creating a league'
      using errcode = 'P0001';
  end if;

  insert into public.leagues (
    name, slug, general_area, timezone, sport_label, description,
    visibility,
    default_capacity, default_min_players,
    default_selection_mode, default_waitlist_mode, default_team_count,
    default_location, typical_schedule,
    gender_field_enabled, goalkeeper_field_enabled,
    created_by
  )
  values (
    btrim(p_name), lower(btrim(p_slug)), btrim(p_general_area), p_timezone,
    btrim(p_sport_label), btrim(p_description),
    'private'::public.league_visibility,          -- always, regardless of input
    p_default_capacity, p_default_min_players,
    p_default_selection_mode, p_default_waitlist_mode, p_default_team_count,
    nullif(btrim(coalesce(p_default_location, '')), ''),
    nullif(btrim(coalesce(p_typical_schedule, '')), ''),
    p_gender_field_enabled, p_goalkeeper_field_enabled,
    v_actor
  )
  returning id into v_league_id;

  insert into public.league_memberships (league_id, user_id, role, status)
  values (v_league_id, v_actor, 'league_admin', 'active');

  perform public.log_audit_event(
    v_league_id, v_actor, 'league', v_league_id, 'league.created',
    null,
    jsonb_build_object('name', btrim(p_name), 'slug', lower(btrim(p_slug)),
                       'visibility', 'private'),
    null
  );

  -- Drop the creator straight into their new league.
  insert into public.user_app_state (user_id, active_league_id)
  values (v_actor, v_league_id)
  on conflict (user_id) do update set active_league_id = excluded.active_league_id;

  return v_league_id;
end;
$$;


-- ── Request to join a searchable league ────────────────────────────────────
-- A private league and a league that does not exist produce the identical
-- error. Anything else would turn this into a probe for private leagues.
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
  -- failing or creating a second one.
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

  return v_request_id;
end;
$$;


-- ── Withdraw your own request ──────────────────────────────────────────────
create or replace function public.withdraw_join_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_request public.league_join_requests;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  select * into v_request
  from public.league_join_requests r
  where r.id = p_request_id and r.user_id = v_actor;

  if not found then
    raise exception 'NOT_AUTHORIZED: no such request' using errcode = '42501';
  end if;

  -- Idempotent, and a decision already made cannot be undone by the requester.
  if v_request.status <> 'pending'::public.join_request_status then
    return;
  end if;

  update public.league_join_requests
     set status = 'withdrawn', decided_at = now(), decision_note = null
   where id = p_request_id;

  perform public.log_audit_event(
    v_request.league_id, v_actor, 'league_join_request', p_request_id,
    'join_request.withdrawn',
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'withdrawn'), null
  );
end;
$$;


-- ── Approve or reject a request ────────────────────────────────────────────
-- Approval is idempotent and creates AT MOST one membership: the insert is an
-- upsert on the (league_id, user_id) unique index, so a second approval — or a
-- re-approval of someone previously removed — reactivates the single existing
-- row instead of creating another.
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
    -- repeated call is a no-op rather than an error.
    select m.id into v_membership_id
    from public.league_memberships m
    where m.league_id = v_request.league_id and m.user_id = v_request.user_id;
    return v_membership_id;
  end if;

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
  end if;

  return v_membership_id;
end;
$$;


-- ── Invitations ────────────────────────────────────────────────────────────
-- The raw token is hashed HERE, inside the database, and only the digest is
-- stored. That ordering matters: because the stored value is a one-way digest
-- of the token, reading `league_invites` — even with full table access — does
-- not let anyone redeem an invitation. Only a holder of the original token can
-- produce a matching digest.
create or replace function public.create_league_invite(
  p_league_id uuid,
  p_token text,
  p_label text default null,
  p_grants_status public.membership_status default 'active',
  p_max_uses integer default null,
  p_expires_in_days integer default 14
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_invite_id uuid;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  if not public.is_league_admin(p_league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  -- Guards against a caller weakening its own invitation.
  if p_token is null or char_length(p_token) < 32 then
    raise exception 'VALIDATION_FAILED: invite token is too short to be unguessable'
      using errcode = 'P0001';
  end if;

  if p_expires_in_days is null or p_expires_in_days < 1 or p_expires_in_days > 90 then
    raise exception 'VALIDATION_FAILED: expiry must be between 1 and 90 days'
      using errcode = 'P0001';
  end if;

  insert into public.league_invites (
    league_id, token_hash, label, grants_status, max_uses, expires_at, created_by
  )
  values (
    p_league_id,
    sha256(convert_to(p_token, 'UTF8')),
    nullif(btrim(coalesce(p_label, '')), ''),
    p_grants_status,
    p_max_uses,
    now() + make_interval(days => p_expires_in_days),
    v_actor
  )
  returning id into v_invite_id;

  perform public.log_audit_event(
    p_league_id, v_actor, 'league_invite', v_invite_id, 'invite.created',
    null,
    jsonb_build_object('label', nullif(btrim(coalesce(p_label, '')), ''),
                       'grants_status', p_grants_status,
                       'max_uses', p_max_uses,
                       'expires_in_days', p_expires_in_days),
    null
  );

  return v_invite_id;
end;
$$;


create or replace function public.revoke_league_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_league_id uuid;
  v_revoked_at timestamptz;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  select i.league_id, i.revoked_at into v_league_id, v_revoked_at
  from public.league_invites i where i.id = p_invite_id;

  if v_league_id is null or not public.is_league_admin(v_league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  -- Idempotent: revoking twice leaves the original revocation timestamp.
  if v_revoked_at is not null then
    return;
  end if;

  update public.league_invites set revoked_at = now() where id = p_invite_id;

  perform public.log_audit_event(
    v_league_id, v_actor, 'league_invite', p_invite_id, 'invite.revoked',
    null, jsonb_build_object('revoked', true), null
  );
end;
$$;


-- Redeem an invitation.
--
-- Every rejection path — unknown token, expired, revoked, exhausted — raises
-- the same INVITE_INVALID error, so a probe cannot distinguish "no such
-- invitation" from "that invitation has run out" and therefore cannot confirm
-- that a private league exists.
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
  -- the invitation's use count is NOT spent.
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

  return jsonb_build_object(
    'league_id', v_invite.league_id,
    'membership_id', v_membership_id,
    'status', v_invite.grants_status,
    'joined', true
  );
end;
$$;


-- ── Manual member addition by email ────────────────────────────────────────
-- F-03: "Administrator can manually add an existing account by email."
--
-- Known trade-off: because any user may create a league and become its
-- administrator, this necessarily tells that administrator whether an address
-- has a Matchday account. That is inherent to the specified feature. It leaks
-- nothing beyond existence — no name, no profile, no other league — and is
-- recorded in the security analysis and TODO.md with a proposed mitigation.
create or replace function public.add_league_member_by_email(
  p_league_id uuid,
  p_email text,
  p_status public.membership_status default 'active'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_target uuid;
  v_membership_id uuid;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  if not public.is_league_admin(p_league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  if p_status not in ('active'::public.membership_status,
                      'pending'::public.membership_status) then
    raise exception 'VALIDATION_FAILED: a member may only be added as active or pending'
      using errcode = 'P0001';
  end if;

  select p.id into v_target
  from public.profiles p
  where p.email_normalized = lower(btrim(p_email));

  if v_target is null then
    raise exception 'PROFILE_NOT_FOUND: no Matchday account uses that email address'
      using errcode = 'P0001';
  end if;

  -- Idempotent, and never a second membership: the upsert targets the same
  -- unique (league_id, user_id) row. An existing administrator is left alone.
  insert into public.league_memberships as m (league_id, user_id, role, status)
  values (p_league_id, v_target, 'player', p_status)
  on conflict (league_id, user_id) do update
    set status = case
                   when m.status = 'removed'::public.membership_status then p_status
                   else m.status
                 end
  returning m.id into v_membership_id;

  perform public.log_audit_event(
    p_league_id, v_actor, 'league_membership', v_membership_id,
    'membership.added_by_admin',
    null, jsonb_build_object('status', p_status), null
  );

  return v_membership_id;
end;
$$;


-- ── Atomic administrator transfer ──────────────────────────────────────────
-- One function call is one statement is one transaction, so the demotion and
-- the promotion either both land or neither does.
--
-- The order is mandatory. `league_memberships_single_active_admin_key` is a
-- partial unique index and is deliberately NOT deferrable, so the seat must be
-- vacated before it can be filled. At COMMIT the deferred constraint trigger
-- re-asserts that the league has exactly one active administrator, which means
-- a failure anywhere in between can only roll back to the original state — the
-- league can never be observed with zero or two administrators.
create or replace function public.transfer_league_administration(
  p_league_id uuid,
  p_target_membership_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_current public.league_memberships;
  v_target public.league_memberships;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  if not public.is_league_admin(p_league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  select * into v_current
  from public.league_memberships m
  where m.league_id = p_league_id
    and m.user_id = v_actor
    and m.role = 'league_admin'::public.league_role
    and m.status = 'active'::public.membership_status;

  select * into v_target
  from public.league_memberships m
  where m.id = p_target_membership_id;

  if v_target.id is null
     or v_target.league_id <> p_league_id                                   -- other tenant
     or v_target.status <> 'active'::public.membership_status               -- must be active
     or v_target.role <> 'player'::public.league_role                       -- must be a player
     or v_target.user_id = v_actor                                          -- not yourself
  then
    raise exception 'ADMIN_TRANSFER_INVALID: the recipient must be an active player in this league'
      using errcode = 'P0001';
  end if;

  -- Vacate first, then fill. Reversing these two statements violates the
  -- partial unique index; tests/db/admin-transfer.test.ts asserts both orders.
  update public.league_memberships
     set role = 'player'::public.league_role
   where id = v_current.id;

  update public.league_memberships
     set role = 'league_admin'::public.league_role
   where id = v_target.id;

  perform public.log_audit_event(
    p_league_id, v_actor, 'league', p_league_id, 'league.administration_transferred',
    jsonb_build_object('admin_membership_id', v_current.id, 'admin_user_id', v_actor),
    jsonb_build_object('admin_membership_id', v_target.id, 'admin_user_id', v_target.user_id),
    nullif(btrim(coalesce(p_reason, '')), '')
  );
end;
$$;

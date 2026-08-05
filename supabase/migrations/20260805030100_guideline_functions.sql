-- Matchday — Phase 3A
-- Guideline operations and the signup-eligibility predicate.
--
-- Same contract as every Phase 2 function: SECURITY DEFINER, `search_path = ''`,
-- actor from `auth.uid()` and never from a parameter, EXECUTE granted by name
-- in 20260805030800.

-- ── The "currently required" version ───────────────────────────────────────
--
-- Exactly one version can be required at a time: the newest published,
-- unarchived, effective version that asks for acceptance.
--
-- WHY NOT "every required version ever published": a member who joins in
-- March would have to retroactively accept January's and February's documents
-- as well, and would be permanently ineligible the moment any historical
-- version was missed. Versions supersede each other; that is what a version is.
create or replace function public.current_required_guideline_version(p_league_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select v.id
  from public.guideline_versions v
  where v.league_id = p_league_id
    and v.published_at is not null
    and v.archived_at is null
    and v.requires_acceptance
    and v.effective_at <= now()
  order by v.effective_at desc, v.published_at desc, v.id desc
  limit 1;
$$;

-- ── The predicate Phase 4 signup will call ─────────────────────────────────
--
-- Answers ONLY about the caller. A variant taking a user id would be an oracle:
-- anyone could ask whether any member of any league had accepted anything.
-- Administrators get league_guideline_acceptance_status() instead, which is
-- gated on administering that league.
--
-- Returns true when the league requires nothing, and false when a required
-- version exists that this caller's active membership has not accepted.
create or replace function public.has_accepted_required_guidelines(p_league_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_required uuid;
  v_membership uuid;
begin
  if v_actor is null then
    return false;
  end if;

  v_required := public.current_required_guideline_version(p_league_id);

  -- Nothing to accept: eligible.
  if v_required is null then
    return true;
  end if;

  select m.id into v_membership
  from public.league_memberships m
  where m.league_id = p_league_id
    and m.user_id = v_actor
    and m.status = 'active';

  -- Not an active member of this league: not eligible, and for a reason that
  -- has nothing to do with guidelines. Phase 4 checks membership separately;
  -- this keeps the predicate total rather than raising.
  if v_membership is null then
    return false;
  end if;

  return exists (
    select 1
    from public.guideline_acceptances a
    where a.membership_id = v_membership
      and a.guideline_version_id = v_required
  );
end;
$$;

-- ── Accept a version ───────────────────────────────────────────────────────
--
-- Acceptance is always explicit and always the caller's own. There is no
-- parameter for whose membership is being accepted, so "accept on behalf of"
-- is not expressible — including by an administrator.
create or replace function public.accept_guideline_version(p_guideline_version_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_version public.guideline_versions;
  v_membership uuid;
  v_acceptance_id uuid;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  select * into v_version
  from public.guideline_versions v
  where v.id = p_guideline_version_id;

  -- An unpublished or archived version is reported exactly as one that does
  -- not exist, so a draft cannot be discovered by guessing identifiers.
  if not found or v_version.published_at is null or v_version.archived_at is not null then
    raise exception 'GUIDELINE_NOT_FOUND: no such published guideline version'
      using errcode = 'P0001';
  end if;

  select m.id into v_membership
  from public.league_memberships m
  where m.league_id = v_version.league_id
    and m.user_id = v_actor
    and m.status = 'active';

  if v_membership is null then
    raise exception 'MEMBERSHIP_REQUIRED: you are not an active member of that league'
      using errcode = 'P0001';
  end if;

  -- Idempotent: accepting twice returns the original acceptance, with its
  -- original timestamp. The row is immutable, so this cannot silently move it.
  insert into public.guideline_acceptances (league_id, guideline_version_id, membership_id)
  values (v_version.league_id, p_guideline_version_id, v_membership)
  on conflict (membership_id, guideline_version_id) do nothing
  returning id into v_acceptance_id;

  if v_acceptance_id is null then
    select a.id into v_acceptance_id
    from public.guideline_acceptances a
    where a.membership_id = v_membership
      and a.guideline_version_id = p_guideline_version_id;
  end if;

  return v_acceptance_id;
end;
$$;

-- ── Publish ────────────────────────────────────────────────────────────────
--
-- Idempotent, audited, and the point at which the text freezes. Notification
-- fanout is attached in 20260805030700, once the notifications table exists.
create or replace function public.publish_guideline_version(p_guideline_version_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_version public.guideline_versions;
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

  -- Already published: nothing changes and no second audit event is written.
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

  return v_version.id;
end;
$$;

-- ── Archive ────────────────────────────────────────────────────────────────
-- Retires a version without deleting it. Archiving the currently required
-- version means the league requires nothing until a new one is published.
create or replace function public.archive_guideline_version(p_guideline_version_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_version public.guideline_versions;
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

  if v_version.published_at is null then
    raise exception 'GUIDELINE_NOT_PUBLISHED: only a published version can be archived'
      using errcode = 'P0001';
  end if;

  if v_version.archived_at is not null then
    return v_version.id;
  end if;

  update public.guideline_versions
     set archived_at = now()
   where id = p_guideline_version_id;

  perform public.log_audit_event(
    v_version.league_id, v_actor, 'guideline_version', p_guideline_version_id,
    'guideline_version.archived',
    jsonb_build_object('archived', false),
    jsonb_build_object('archived', true, 'version_label', v_version.version_label),
    null
  );

  return v_version.id;
end;
$$;

-- ── Administrator view of who has accepted ─────────────────────────────────
--
-- The only way to ask about somebody else, and it is gated on administering
-- the league in question. Returns membership ids, never profile fields — the
-- caller joins those through the profile policy they already hold.
create or replace function public.league_guideline_acceptance_status(p_league_id uuid)
returns table (
  membership_id uuid,
  user_id uuid,
  membership_status public.membership_status,
  required_version_id uuid,
  accepted boolean,
  accepted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_required uuid;
begin
  if auth.uid() is null or not public.is_league_admin(p_league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  v_required := public.current_required_guideline_version(p_league_id);

  return query
    select
      m.id,
      m.user_id,
      m.status,
      v_required,
      (v_required is null or a.id is not null),
      a.accepted_at
    from public.league_memberships m
    left join public.guideline_acceptances a
      on a.membership_id = m.id
     and a.guideline_version_id = v_required
    where m.league_id = p_league_id
      and m.status <> 'removed'
    order by m.role, m.created_at;
end;
$$;

-- MatchDay — deleting your own account.
--
-- ── TWO PHASES, BECAUSE THERE ARE THREE SYSTEMS ────────────────────────────
--
-- Deleting an account touches Postgres, Storage and GoTrue. Only the first is
-- transactional; Storage refuses SQL deletes outright (`storage.protect_delete`
-- raises on any direct DELETE) and GoTrue is an HTTP service on the other side
-- of a connection this database knows nothing about. A single function
-- pretending otherwise would be a lie with a rollback attached to it.
--
-- So the database does two things at two different moments:
--
--   begin_my_account_deletion()
--     Confirms nothing blocks the deletion and stamps `deletion_started_at`.
--     From that instant the account cannot participate — including, crucially,
--     it cannot upload a new avatar, which is what makes the Storage cleanup
--     that follows terminate rather than race an upload.
--
--   finalize_my_account_deletion()
--     Everything transactional: the future-match withdrawals, the membership
--     departures, the transient personal rows, the notification rewrite and the
--     profile scrub. Stamps `deleted_at`, which is a promise that no personal
--     data remains in this row.
--
-- Between them the application empties the avatar folder. If it fails, nothing
-- is finalized and the account sits in the pending state until a retry or the
-- reconciler picks it up — visible, bounded, and safe, because a pending
-- account can do nothing at all.
--
-- Both are idempotent. Every failure mode here is "run it again".

-- ══ What is stopping me ════════════════════════════════════════════════════
--
-- The leagues the caller administers that are still open. A closed league does
-- not block: it has no administrator to replace.
--
-- Returned as rows rather than as a boolean so the UI can name each league and
-- link to its own Members page. Nothing is authorized from this — it is the
-- explanation, and `begin_my_account_deletion` re-derives the same fact inside
-- its own transaction, where a transfer landing a moment ago cannot be missed.
create or replace function public.my_account_deletion_blockers()
returns table (league_id uuid, league_name text, league_slug text, has_transfer_target boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select
    l.id, l.name, l.slug,
    -- Whether "transfer administration" is advice this person can actually
    -- follow. `transfer_league_administration` requires an active player in the
    -- same league; with none, closing is the only route and the UI must not
    -- pretend otherwise.
    exists (
      select 1 from public.league_memberships t
      where t.league_id = l.id
        and t.status = 'active'
        and t.role = 'player'
    )
  from public.league_memberships m
  join public.leagues l on l.id = m.league_id
  where m.user_id = auth.uid()
    and m.role = 'league_admin'
    and m.status = 'active'
    and l.closed_at is null
  order by l.name;
$$;

comment on function public.my_account_deletion_blockers() is
  'Open leagues the caller administers, each with whether a transfer target '
  'exists. Empty means account deletion may begin.';

revoke execute on function public.my_account_deletion_blockers() from public;
grant execute on function public.my_account_deletion_blockers() to authenticated, service_role;


-- ══ Phase one ══════════════════════════════════════════════════════════════
create or replace function public.begin_my_account_deletion()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_profile public.profiles;
  v_blocking integer;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  select * into v_profile from public.profiles p where p.id = v_actor for update;

  if not found then
    raise exception 'PROFILE_INCOMPLETE: there is no profile to delete'
      using errcode = 'P0001';
  end if;

  -- Idempotent, and deliberately so: a retry from a user whose Storage cleanup
  -- failed calls this again, and starting a deletion twice is the same
  -- deletion. Returning the original timestamp rather than a fresh one keeps
  -- "when did this begin" honest.
  if v_profile.deletion_started_at is not null then
    return v_profile.deletion_started_at;
  end if;

  -- ── The one thing that can refuse ───────────────────────────────────────
  --
  -- Queried directly rather than through `is_league_admin`, which now requires
  -- a live profile and would therefore answer differently the second time this
  -- function ran. An eligibility check must not depend on the state it is about
  -- to create.
  select count(*) into v_blocking
  from public.league_memberships m
  join public.leagues l on l.id = m.league_id
  where m.user_id = v_actor
    and m.role = 'league_admin'
    and m.status = 'active'
    and l.closed_at is null;

  if v_blocking > 0 then
    raise exception
      'ADMIN_TRANSFER_INVALID: transfer administration or close your leagues before deleting your account'
      using errcode = 'P0001';
  end if;

  update public.profiles set deletion_started_at = now() where id = v_actor;

  return (select p.deletion_started_at from public.profiles p where p.id = v_actor);
end;
$$;

comment on function public.begin_my_account_deletion() is
  'Marks the caller''s account as deleting. Refuses while they administer an '
  'open league. Idempotent. From this point the account cannot participate in '
  'MatchDay, which is what makes avatar cleanup safe to run afterwards.';

revoke execute on function public.begin_my_account_deletion() from public;
grant execute on function public.begin_my_account_deletion() to authenticated, service_role;


-- ══ Phase two ══════════════════════════════════════════════════════════════
--
-- The whole scrub, in one transaction, addressed by profile id.
--
-- SEPARATED FROM THE `my_` WRAPPER so the reconciler can finish somebody else's
-- abandoned deletion without a session. It is granted to `service_role` only,
-- and it refuses any profile that has not already started deleting — so it can
-- never be aimed at a live account, which is the property that makes a
-- background job holding this capability acceptable.
create or replace function public.finalize_account_deletion(p_profile_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_membership record;
  v_match record;
  v_blocking integer;
  v_former_name text;
begin
  select * into v_profile from public.profiles p where p.id = p_profile_id for update;

  if not found then
    raise exception 'PROFILE_INCOMPLETE: no such profile' using errcode = 'P0001';
  end if;

  -- THE LINE THAT MAKES THIS SAFE TO GRANT. No live account can be reached
  -- through this function, however it is called and by whom.
  if v_profile.deletion_started_at is null then
    raise exception 'NOT_AUTHORIZED: that account is not being deleted'
      using errcode = '42501';
  end if;

  -- Already done. Idempotent for the retry and for the reconciler arriving
  -- after a user-initiated retry already finished.
  if v_profile.deleted_at is not null then
    return v_profile.deleted_at;
  end if;

  -- Re-checked here as well as in phase one: a transfer could have made them an
  -- administrator again in between, and finalizing then would leave an open
  -- league with nobody in charge. The deferred constraint would refuse the
  -- commit anyway; this refuses it with a sentence somebody can act on.
  select count(*) into v_blocking
  from public.league_memberships m
  join public.leagues l on l.id = m.league_id
  where m.user_id = p_profile_id
    and m.role = 'league_admin'
    and m.status = 'active'
    and l.closed_at is null;

  if v_blocking > 0 then
    raise exception
      'ADMIN_TRANSFER_INVALID: this account still administers an open league'
      using errcode = 'P0001';
  end if;

  -- The name as it appears in any `member_left` body written for this person,
  -- reconstructed exactly as `leave_league` built it. Captured before the scrub
  -- because the scrub is what makes it unavailable.
  v_former_name := coalesce(
    nullif(btrim(v_profile.first_name || ' ' || v_profile.last_name), ''),
    'A member'
  );

  -- ── Future matches, then departure, league by league ────────────────────
  --
  -- `withdraw_membership_from_match` is the single implementation of what
  -- leaving a match means — capacity released, waitlist compacted, automatic
  -- promotion, published teams republished, `teams_changed` sent — and account
  -- deletion uses it rather than growing a third copy of that cascade.
  --
  -- Ordered by membership then match id so concurrent operations take locks in
  -- a consistent sequence.
  for v_membership in
    select m.id, m.league_id
    from public.league_memberships m
    where m.user_id = p_profile_id
    order by m.id
  loop
    for v_match in
      select mt.id
      from public.matches mt
      join public.match_signups s on s.match_id = mt.id
      where mt.league_id = v_membership.league_id
        and s.membership_id = v_membership.id
        and s.status in ('interested', 'confirmed', 'waitlisted')
        and mt.status not in ('canceled', 'completed')
        and mt.kickoff_at > now()
      order by mt.id
      for update of mt
    loop
      perform public.withdraw_membership_from_match(v_match.id, v_membership.id, p_profile_id);
    end loop;

    -- `status_reason` to NULL rather than to a sentence: it is administrator
    -- free text attached to this person's identity, and the requirement is that
    -- no such text survives them.
    update public.league_memberships
       set status = 'removed', status_reason = null, suspended_until = null
     where id = v_membership.id
       and status <> 'removed';

    -- ── The notifications that name them ────────────────────────────────────
    --
    -- An administrator's `member_left` alert is an operational record and stays
    -- — but it carries this person's name in persisted body text, which is the
    -- one place in the schema where a name is written into a notification.
    -- Matched by reconstructing the exact string `leave_league` produces rather
    -- than by a LIKE, so it can neither miss nor touch somebody else's row.
    update public.notifications n
       set body = 'A member left ' || l.name || '.'
      from public.leagues l
     where l.id = n.league_id
       and n.league_id = v_membership.league_id
       and n.type = 'member_left'
       and n.body = v_former_name || ' left ' || l.name || '.';

    -- Administrator notes about this person. Their author's writing, but about
    -- somebody who has asked to be forgotten, and of no operational value once
    -- the member is gone.
    delete from public.league_membership_admin_notes
     where membership_id = v_membership.id;
  end loop;

  -- ── Transient personal rows ─────────────────────────────────────────────
  --
  -- EXPLICIT DELETES, NOT CASCADES. Until this release every one of these
  -- disappeared automatically when the profile did. The profile now survives,
  -- so each has to be named — and a table forgotten here leaves personal data
  -- behind with nothing to signal it. `push_delivery_attempts` is the only one
  -- still removed by cascade, from `push_subscriptions`.
  delete from public.push_subscriptions where user_id = p_profile_id;
  delete from public.user_app_state where user_id = p_profile_id;
  delete from public.league_join_requests where user_id = p_profile_id;
  delete from public.notifications where recipient_user_id = p_profile_id;

  -- ── The tombstone ───────────────────────────────────────────────────────
  --
  -- `first_name`, `last_name` and `email_normalized` are NOT NULL with CHECK
  -- constraints, so neutral values are forced rather than chosen.
  --
  -- THE SYNTHETIC ADDRESS is built from the profile id, which is not derived
  -- from the email in any way — not a hash, not an HMAC, not an encoding. It is
  -- a value that existed before the address was ever known. `.invalid` is
  -- reserved by RFC 2606 and can never be a real domain, so it can never
  -- collide with a genuine account, and the original address is free for a new
  -- signup the moment this commits.
  --
  -- `profiles_sync_identity` would otherwise put the JWT's real email straight
  -- back; it stands down because `deletion_started_at` is set. That is the
  -- single most easily missed failure in this whole workflow and it fails
  -- silently, which is why it has a regression test of its own.
  update public.profiles
     set first_name = 'Former',
         last_name = 'member',
         email_normalized = 'deleted-' || p_profile_id::text || '@deleted.invalid',
         phone = null,
         gender = null,
         preferred_positions = '{}'::text[],
         goalkeeper_willing = null,
         profile_photo_url = null,
         profile_photo_path = null,
         deleted_at = now()
   where id = p_profile_id;

  return (select p.deleted_at from public.profiles p where p.id = p_profile_id);
end;
$$;

comment on function public.finalize_account_deletion(uuid) is
  'The transactional half of account deletion: future-match withdrawal, '
  'membership departure, transient personal rows, member_left rewrite and the '
  'profile scrub. Refuses any profile that has not started deleting, so it can '
  'never be aimed at a live account. Idempotent.';

revoke execute on function public.finalize_account_deletion(uuid) from public;
grant execute on function public.finalize_account_deletion(uuid) to service_role;


-- The caller's own. No argument, so there is no id to substitute.
create or replace function public.finalize_my_account_deletion()
returns timestamptz
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

  return public.finalize_account_deletion(v_actor);
end;
$$;

comment on function public.finalize_my_account_deletion() is
  'finalize_account_deletion() for the caller''s own profile, resolved from '
  'auth.uid(). No user id crosses the client boundary.';

revoke execute on function public.finalize_my_account_deletion() from public;
grant execute on function public.finalize_my_account_deletion() to authenticated, service_role;


-- ══ Reconciliation ═════════════════════════════════════════════════════════
--
-- Every account whose deletion has begun and has not demonstrably finished.
-- "Finished" is a fact spanning two systems, so this reports both halves and
-- lets the worker decide: a scrub that never ran, an Auth row that never went,
-- or both.
--
-- READS auth.users, WHICH IS THE POINT. Nothing else can tell the difference
-- between "Auth deletion succeeded" and "Auth deletion was never attempted",
-- and an account whose Auth row survives is NOT deleted — that row still holds
-- the real email address however anonymous the profile has become.
--
-- Service role only: it is a list of accounts in a vulnerable state and has no
-- business being reachable from a session.
create or replace function public.accounts_awaiting_deletion(p_limit integer default 50)
returns table (
  profile_id uuid,
  deletion_started_at timestamptz,
  deleted_at timestamptz,
  auth_user_exists boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id,
    p.deletion_started_at,
    p.deleted_at,
    exists (select 1 from auth.users u where u.id = p.id)
  from public.profiles p
  where p.deletion_started_at is not null
    and (
      p.deleted_at is null
      or exists (select 1 from auth.users u where u.id = p.id)
    )
  order by p.deletion_started_at
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

comment on function public.accounts_awaiting_deletion(integer) is
  'Accounts whose deletion began but is not demonstrably complete: the scrub '
  'has not run, or the Auth row still exists. An Auth row that survives still '
  'holds the real email, so its presence alone means not-yet-deleted.';

revoke execute on function public.accounts_awaiting_deletion(integer) from public;
grant execute on function public.accounts_awaiting_deletion(integer) to service_role;

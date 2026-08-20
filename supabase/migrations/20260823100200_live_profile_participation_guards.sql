-- MatchDay — the surfaces a departing account can reach without a membership.
--
-- ── WHY TRIGGERS AND NOT ELEVEN REWRITTEN FUNCTIONS ────────────────────────
--
-- The audit found eleven RPCs a deletion-pending account could still call,
-- because they need no existing membership: creating a league, requesting to
-- join one, redeeming an invitation, registering a device, and mutating one's
-- own notifications. The obvious fix is to open each and add a guard.
--
-- Two things are wrong with that. It duplicates two hundred lines of unrelated
-- function bodies into this migration purely to insert one line into each, and
-- every such copy is a chance for the original and the copy to drift. And it
-- protects only the eleven paths that exist *today* — it says nothing about the
-- twelfth, written next year, by somebody who has never read this file.
--
-- The rule underneath all eleven is a single sentence: **an account whose
-- deletion has begun may not acquire or hold participation in MatchDay.** That
-- is a statement about rows, so it belongs on the tables. Written this way it
-- also catches paths the function-by-function version would have missed
-- entirely — an administrator approving a join request from somebody who is
-- mid-deletion, or adding them by email, neither of which is a call the
-- departing user makes at all.
--
-- ── THE ONE EXEMPTION, AND WHY IT IS SAFE ──────────────────────────────────
--
-- `status = 'removed'` is always permitted. It is the direction the deletion
-- workflow moves memberships, and it is the only status that grants nothing:
-- every predicate in this schema requires `active`, or at least not-`removed`.
-- A rule that blocked it would block its own cleanup.

-- ── Match participation ────────────────────────────────────────────────────
--
-- One chokepoint rather than five guards. `join_match`, `request_spot`,
-- `cancel_spot`, `mark_unavailable` and `accept_guideline_version` all resolve
-- the caller's membership through this function and refuse when it returns
-- null, so liveness here is liveness in all five.
--
-- Note this is *also* covered later by the membership sweep, which sets every
-- membership to `removed`. The two are independent: this holds from the instant
-- `deletion_started_at` is written, which is before the sweep has run.
create or replace function public.my_active_membership_id(p_league_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id
  from public.league_memberships m
  where m.league_id = p_league_id
    and m.user_id = auth.uid()
    and m.status = 'active'
    and public.is_live_profile();
$$;


-- ── Memberships ────────────────────────────────────────────────────────────
--
-- The widest of the guards, and the one that closes the resurrection path: a
-- tombstoned account creating a league becomes its administrator through this
-- table, and a rejoin through an invitation or an approved request arrives here
-- too.
create or replace function public.league_memberships_guard_live_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The direction the deletion workflow moves, and the status that grants
  -- nothing. Always allowed, or the workflow could not finish.
  if new.status = 'removed' then
    return new;
  end if;

  -- ABOUT THE MEMBER, NOT ABOUT THE CALLER. `create_league` and
  -- `redeem_league_invite` are the departing user acting on themselves;
  -- `decide_join_request` and `add_league_member_by_email` are an administrator
  -- acting on them. Both must be refused, and only a subject-side check
  -- refuses both.
  if not public.is_live_profile_id(new.user_id) then
    raise exception 'ACCOUNT_DELETION_IN_PROGRESS: this account is being deleted'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger league_memberships_guard_live_profile
  before insert or update on public.league_memberships
  for each row execute function public.league_memberships_guard_live_profile();

revoke execute on function public.league_memberships_guard_live_profile() from public;


-- ── Leagues ────────────────────────────────────────────────────────────────
--
-- `create_league` writes the league before the membership, so without this the
-- refusal above would arrive one statement late — correct, since both are in
-- one transaction, but reported as a membership problem for what is plainly a
-- league one.
create or replace function public.leagues_guard_live_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not public.is_live_profile() then
    raise exception 'ACCOUNT_DELETION_IN_PROGRESS: this account is being deleted'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger leagues_guard_live_profile
  before insert on public.leagues
  for each row execute function public.leagues_guard_live_profile();

revoke execute on function public.leagues_guard_live_profile() from public;


-- ── Join requests ──────────────────────────────────────────────────────────
create or replace function public.league_join_requests_guard_live_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_live_profile_id(new.user_id) then
    raise exception 'ACCOUNT_DELETION_IN_PROGRESS: this account is being deleted'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger league_join_requests_guard_live_profile
  before insert or update on public.league_join_requests
  for each row execute function public.league_join_requests_guard_live_profile();

revoke execute on function public.league_join_requests_guard_live_profile() from public;


-- ── Devices ────────────────────────────────────────────────────────────────
--
-- INSERT and UPDATE only. DELETE stays open because retiring a device is how
-- the deletion workflow removes them, and because a push endpoint is a bearer
-- credential — there is no state of this account in which deleting one should
-- be refused.
create or replace function public.push_subscriptions_guard_live_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_live_profile_id(new.user_id) then
    raise exception 'ACCOUNT_DELETION_IN_PROGRESS: this account is being deleted'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger push_subscriptions_guard_live_profile
  before insert or update on public.push_subscriptions
  for each row execute function public.push_subscriptions_guard_live_profile();

revoke execute on function public.push_subscriptions_guard_live_profile() from public;


-- ── Notifications ──────────────────────────────────────────────────────────
--
-- UPDATE only, and only for the caller's own inbox. INSERT is untouched because
-- a domain function writing to *other* people is not this rule's business, and
-- DELETE is how the workflow clears the departing user's own inbox.
--
-- The `member_left` rewrite in `finalize_my_account_deletion` updates rows
-- belonging to an *administrator* — a live profile — so the subject-side check
-- passes it while still refusing any change to a departing person's own inbox.
create or replace function public.notifications_guard_live_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_live_profile_id(new.recipient_user_id) then
    raise exception 'ACCOUNT_DELETION_IN_PROGRESS: this account is being deleted'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger notifications_guard_live_profile
  before update on public.notifications
  for each row execute function public.notifications_guard_live_profile();

revoke execute on function public.notifications_guard_live_profile() from public;

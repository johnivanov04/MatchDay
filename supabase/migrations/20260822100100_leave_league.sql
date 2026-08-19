-- MatchDay — a player can leave a league.
--
-- ── THE GAP ────────────────────────────────────────────────────────────────
--
-- Every other way a membership ends belonged to somebody else. An
-- administrator could remove you; a suspension could stop you playing; nothing
-- at all let *you* decide you were finished with a league. The self-service
-- rehearsal found it immediately: the only route out was to email an
-- organizer and ask them to remove you, which is the shape of a problem this
-- product exists to remove.
--
-- ── WHY A NEW FUNCTION AND NOT A LOOSER `set_membership_status()` ──────────
--
-- `set_membership_status()` is administrator-only in its first ten lines, and
-- that check is the whole reason it can be trusted with a membership id chosen
-- by the caller. Relaxing it to "…or it is your own membership" would mean a
-- function whose authorization depends on which argument you passed, and every
-- future change to it would have to be read twice.
--
-- So this is a separate entry point with a different shape: it takes a *league*
-- and resolves the membership from `auth.uid()`. There is no membership id and
-- no user id to forge, because neither crosses the client boundary. The worst a
-- forged `p_league_id` can do is name a league the caller does not belong to,
-- which is the refusal below.
--
-- The parts that are genuinely shared — withdrawing from future matches — are
-- called, not copied. `withdraw_membership_from_match()` remains the single
-- implementation of what leaving a match means.

create function public.leave_league(p_league_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_membership public.league_memberships;
  v_changed_at timestamptz;
  v_league record;
  v_admin_user uuid;
  v_player_name text;
  v_match record;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  -- ── The one row that matters ──────────────────────────────────────────────
  --
  -- Resolved from the session and the league, never from an argument naming a
  -- person. FOR NO KEY UPDATE for exactly the reason `set_membership_status()`
  -- documents at length: it excludes the FOR SHARE that
  -- `match_signups_guard_membership_active` takes — so a signup racing this
  -- departure either commits first and is found by the scan below, or waits and
  -- reads the removal — while leaving the FOR KEY SHARE of an ordinary foreign
  -- key check alone, which is what stops this deadlocking against somebody
  -- publishing teams at the same moment.
  select * into v_membership
  from public.league_memberships m
  where m.league_id = p_league_id and m.user_id = v_actor
  for no key update;

  -- A league the caller does not belong to and a league that does not exist
  -- answer identically, so a guessed id cannot be used to discover that a
  -- private league is real.
  if not found then
    raise exception 'MEMBERSHIP_REQUIRED: you are not a member of that league'
      using errcode = '42501';
  end if;

  -- ── The administrator cannot walk out ─────────────────────────────────────
  --
  -- Checked first so the caller gets the sentence that tells them what to do,
  -- rather than the cardinality violation the deferred constraint would raise
  -- at COMMIT. The constraint and the partial unique index are still the actual
  -- guarantee; this is the readable version of them.
  --
  -- Nothing here promotes a replacement. Choosing who runs a league is a
  -- decision, and `transfer_league_administration()` is where somebody makes it.
  if v_membership.role = 'league_admin' then
    raise exception
      'ADMIN_TRANSFER_INVALID: transfer administration before leaving this league'
      using errcode = 'P0001';
  end if;

  -- `active` and `suspended` may leave. A suspension is a restriction on
  -- playing, not a requirement to stay on the roster — making it the one status
  -- that traps somebody in a league would turn it into a punishment the product
  -- does not otherwise impose.
  --
  -- `pending` is not a membership yet, it is a request, and
  -- `withdraw_join_request()` already cancels it. `removed` has already left,
  -- and refusing here is what makes a second call unable to write a second
  -- notification.
  if v_membership.status not in ('active', 'suspended') then
    raise exception 'MEMBERSHIP_INACTIVE: you are not an active member of that league'
      using errcode = 'P0001';
  end if;

  -- ── Leaving ───────────────────────────────────────────────────────────────
  --
  -- `removed`, not a new status value. Six tables cascade-delete from
  -- `league_memberships` — attendance, signups, team assignments, publication
  -- entries, guideline acceptances, administrator notes — so a hard delete
  -- would erase the person's entire history in the league, and a fourth enum
  -- value would have to be taught to every policy, projection and query that
  -- currently reads `status = 'active'`.
  --
  -- The record of *who* decided is not lost by sharing the status: the Phase 1
  -- audit trigger stamps `membership.status_changed` with the actor, so a
  -- self-leave and an administrator's removal are told apart by the person on
  -- the event rather than by the word in the column.
  update public.league_memberships
     set status = 'removed',
         status_reason = 'Left voluntarily.',
         -- Meaningless once the membership has ended, and leaving it set would
         -- describe a suspension that is no longer in force.
         suspended_until = null
   where id = v_membership.id
  returning status_changed_at into v_changed_at;

  -- ── The future, released ──────────────────────────────────────────────────
  --
  -- Character for character the scan `set_membership_status()` performs, and
  -- deliberately so: leaving voluntarily and being removed have exactly the
  -- same consequences for the matches somebody was holding a place in, and two
  -- similar-but-different cascades would diverge the first time one was fixed.
  --
  -- Ordered by id so two status changes touching overlapping matches take their
  -- locks in the same sequence and cannot deadlock. Past, completed and
  -- cancelled matches are not in the scan at all — that is history, and history
  -- is not edited by somebody leaving.
  for v_match in
    select m.id
    from public.matches m
    join public.match_signups s on s.match_id = m.id
    where m.league_id = p_league_id
      and s.membership_id = v_membership.id
      and s.status in ('interested', 'confirmed', 'waitlisted')
      and m.status not in ('canceled', 'completed')
      and m.kickoff_at > now()
    order by m.id
    for update of m
  loop
    perform public.withdraw_membership_from_match(v_match.id, v_membership.id, v_actor);
  end loop;

  -- ── The working context ───────────────────────────────────────────────────
  --
  -- Cleared rather than repointed. Which league somebody looks at next is a
  -- question the application already answers — `resolveActiveMembership` treats
  -- the stored value as a hint and re-checks it against live memberships on
  -- every request, falling back to the first remaining active membership, or to
  -- the no-active-league dashboard when there is none. Choosing a replacement
  -- here would be a second implementation of that rule, in SQL, out of sight.
  --
  -- Left as tidiness rather than as correctness: nothing authorizes from this
  -- column, and a stale pointer would already have been ignored.
  update public.user_app_state
     set active_league_id = null
   where user_id = v_actor and active_league_id = p_league_id;

  -- ── Telling the administrator ─────────────────────────────────────────────
  --
  -- One person, in the app, with no push — see the enum migration for why. The
  -- administrator is the only recipient: who is in a league is member-only
  -- information, and announcing a departure to everybody would publish one
  -- person's decision to the whole roster.
  select l.name, l.slug into v_league
  from public.leagues l where l.id = p_league_id;

  select m.user_id into v_admin_user
  from public.league_memberships m
  where m.league_id = p_league_id
    and m.role = 'league_admin'
    and m.status = 'active';

  if v_admin_user is not null then
    select btrim(p.first_name || ' ' || p.last_name) into v_player_name
    from public.profiles p where p.id = v_actor;

    -- Keyed on the membership *and the moment it changed*, so the row is
    -- written once however many times a retried request arrives — and a person
    -- who rejoins months later and leaves again generates a second, genuinely
    -- different event rather than colliding with their first departure.
    perform public.create_notification(
      v_admin_user, p_league_id, 'member_left',
      'A member left',
      coalesce(nullif(v_player_name, ''), 'A member') || ' left ' || v_league.name || '.',
      '/leagues/' || v_league.slug || '/members',
      'member_left:' || v_membership.id::text || ':' || v_changed_at::text,
      null,
      '{}'::jsonb
    );
  end if;

  -- NO AUDIT CALL HERE, for the reason `set_membership_status()` gives:
  -- `league_memberships_audit_change` has recorded `membership.status_changed`
  -- for any authenticated change by any path since Phase 1, and it carries the
  -- actor and the reason. A second event would put two rows in the trail for
  -- one decision.
  return v_membership.id;
end;
$$;

comment on function public.leave_league(uuid) is
  'Ends the calling user''s own membership of a league. Resolves the membership '
  'from auth.uid() so no membership or user id crosses the client boundary. '
  'Refuses the league administrator — transfer administration first. Withdraws '
  'the member from future matches via withdraw_membership_from_match(), clears '
  'the active-league pointer, and notifies the administrator in-app.';


-- ── Execution ──────────────────────────────────────────────────────────────
--
-- A newly created function is EXECUTE-able by PUBLIC until it is not, which is
-- the hole 20260805030900 closed for every function that existed then and which
-- `tests/db/schema.test.ts` asserts against. Revoked, then granted to exactly
-- the roles the equivalent membership RPCs hold.

revoke execute on function public.leave_league(uuid) from public;
grant execute on function public.leave_league(uuid) to authenticated, service_role;

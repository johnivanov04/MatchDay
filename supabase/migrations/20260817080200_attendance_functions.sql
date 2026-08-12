-- Matchday — Phase 7D/7E/7G/7H/7J
-- Recording attendance, correcting it, and completing a match.
--
-- Every function takes `lock_match_as_admin()` first — the same match-row lock
-- Phases 4, 5 and 6 take — so attendance, a completion and any surviving roster
-- operation queue behind one another rather than interleaving.


-- ── What outcome a cancellation implies ────────────────────────────────────
--
-- The Phase 5 classification is authoritative and is never recomputed here.
-- `canceled` and `withdrawn_late` were decided against the match's own cutoff
-- at the moment of withdrawal; re-deriving them now, against a cutoff an
-- administrator may since have edited, would silently relabel history.
--
-- 02 §16 keeps a late cancellation distinct from a no-show, and this is where
-- that holds: `withdrawn_late` suggests `canceled_late`, never `no_show`.
-- Somebody who withdrew late and then turned up anyway is a correction an
-- administrator makes deliberately, not something inferred.
create or replace function public.suggested_attendance_outcome(
  p_signup_status public.signup_status
)
returns public.attendance_outcome
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case p_signup_status
    when 'canceled' then 'canceled_on_time'::public.attendance_outcome
    when 'withdrawn_late' then 'canceled_late'::public.attendance_outcome
    -- Still confirmed at kickoff: whether they actually turned up is the one
    -- thing only a human present at the pitch knows.
    else null
  end;
$$;


-- ── When attendance may be recorded ────────────────────────────────────────
--
-- After the match has ended, by the match's own stored `end_at` and the
-- database clock. Never the browser's, and never kickoff — a match in progress
-- has no attendance yet, and the half-hour between kickoff and the final
-- whistle is exactly when a late arrival stops being a no-show.
--
-- Canceled matches take none: nobody played, and every participant already
-- knows why.
create or replace function public.match_accepts_attendance(p_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.matches m
    where m.id = p_match_id
      and m.status <> 'canceled'
      and m.published_at is not null
      and now() >= m.end_at
  );
$$;


-- ── Recording, and correcting ──────────────────────────────────────────────
--
-- One function for both. A correction is the same act with a row already
-- present, and splitting them would mean two places to keep the validation,
-- the audit shape and the notification key consistent.
--
-- `p_expected_revision` is optional stale-write protection: the workspace sends
-- the revision it rendered, and a form left open while somebody else corrected
-- the same record is refused rather than silently overwriting them.
create or replace function public.record_attendance(
  p_match_id uuid,
  p_membership_id uuid,
  p_outcome public.attendance_outcome,
  p_note text default null,
  p_expected_revision integer default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_signup public.match_signups;
  v_existing public.attendance_records;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_revision integer;
  v_user uuid;
  v_slug text;
begin
  v_match := public.lock_match_as_admin(p_match_id);

  if not public.match_accepts_attendance(p_match_id) then
    raise exception
      'ATTENDANCE_NOT_OPEN: attendance can be recorded once the match has ended'
      using errcode = 'P0001';
  end if;

  -- Attendance is for people who were confirmed. A waitlist-only withdrawal
  -- has `status = 'canceled'` exactly like a confirmed player who cancelled,
  -- and giving them `canceled_on_time` would record participation that never
  -- happened — so the population is `confirmed_at`, not status.
  if not exists (
    select 1 from public.match_attendance_population(p_match_id) id
    where id = p_membership_id
  ) then
    raise exception
      'ATTENDANCE_NOT_ELIGIBLE: that member was never confirmed for this match'
      using errcode = 'P0001';
  end if;

  select * into v_signup
  from public.match_signups s
  where s.match_id = p_match_id and s.membership_id = p_membership_id;

  -- A player who withdrew did not play, and cannot be marked as having done so.
  -- The administrator may still choose between the cancellation outcomes and
  -- `excused_absence`, which is the correction 02 §16 exists to allow.
  if v_signup.status in ('canceled', 'withdrawn_late')
     and p_outcome in ('attended', 'no_show')
  then
    raise exception
      'ATTENDANCE_OUTCOME_INVALID: a player who withdrew cannot be marked % ',
      p_outcome using errcode = 'P0001';
  end if;

  -- And somebody who never withdrew cannot be recorded as having cancelled.
  if public.signup_consumes_capacity(v_signup.status)
     and p_outcome in ('canceled_on_time', 'canceled_late')
  then
    raise exception
      'ATTENDANCE_OUTCOME_INVALID: that player never cancelled'
      using errcode = 'P0001';
  end if;

  select * into v_existing
  from public.attendance_records a
  where a.match_id = p_match_id and a.membership_id = p_membership_id;

  if found then
    if p_expected_revision is not null and p_expected_revision <> v_existing.revision then
      raise exception
        'ATTENDANCE_REVISION_STALE: somebody else changed this record; reload and try again'
        using errcode = 'P0001';
    end if;

    -- Nothing changed: leave the revision alone so a repeated press neither
    -- rewrites history nor notifies again.
    if v_existing.outcome = p_outcome and v_existing.note is not distinct from v_note then
      return v_existing.revision;
    end if;

    v_revision := v_existing.revision + 1;

    update public.attendance_records
       set outcome = p_outcome,
           note = v_note,
           revision = v_revision,
           corrected_by = v_actor,
           corrected_at = now()
     where id = v_existing.id;
  else
    v_revision := 1;

    insert into public.attendance_records (
      league_id, match_id, membership_id, outcome, note, recorded_by
    )
    values (v_match.league_id, p_match_id, p_membership_id, p_outcome, v_note, v_actor);
  end if;

  select m.user_id into v_user
  from public.league_memberships m where m.id = p_membership_id;
  select l.slug into v_slug from public.leagues l where l.id = v_match.league_id;

  -- One notification per recorded state. Keyed on the revision, so a correction
  -- tells them again and a retry does not.
  --
  -- NOT push-eligible: `attendance_recorded` is deliberately absent from
  -- PUSH_ELIGIBLE_TYPES. 02 §14 requires the canonical record; nothing in the
  -- approved policy asks for "no-show" on somebody's lock screen, and a push
  -- payload renders where anyone glancing at the phone can read it.
  perform public.create_notification(
    v_user, v_match.league_id, 'attendance_recorded',
    'Attendance recorded: ' || v_match.title,
    case p_outcome
      when 'attended' then 'You are recorded as having played.'
      when 'excused_absence' then 'You are recorded as an excused absence.'
      when 'canceled_on_time' then 'You are recorded as having cancelled before the cutoff.'
      when 'canceled_late' then 'You are recorded as having cancelled after the cutoff.'
      else 'You are recorded as not having attended.'
    end,
    '/leagues/' || v_slug || '/matches/' || p_match_id::text,
    'attendance:' || p_match_id::text || ':' || p_membership_id::text
      || ':' || v_revision::text,
    p_match_id,
    jsonb_build_object('push_eligible', false)
  );

  -- Compact, and without the note: an audit row is readable by every future
  -- administrator, and the note is free text about a person.
  perform public.log_audit_event(
    v_match.league_id, v_actor, 'attendance', p_match_id,
    case when v_existing.id is null then 'attendance.recorded' else 'attendance.corrected' end,
    case when v_existing.id is null then null
         else jsonb_build_object('membership_id', p_membership_id,
                                 'outcome', v_existing.outcome::text,
                                 'revision', v_existing.revision) end,
    jsonb_build_object('membership_id', p_membership_id,
                       'outcome', p_outcome::text,
                       'revision', v_revision,
                       'had_note', v_note is not null),
    null
  );

  return v_revision;
end;
$$;


-- ── Completing a match ─────────────────────────────────────────────────────
--
-- Requires the match to have ended and every attendance-eligible participant to
-- have an outcome. Without the second condition `completed` would mean nothing
-- more than "somebody pressed a button", and the register would be quietly
-- incomplete for ever.
--
-- Deliberately independent of teams. A match may be played without teams ever
-- being published — a five-a-side that picked sides on the pitch is still a
-- match with attendance — so completion never consults `team_revision`.
create or replace function public.complete_match(p_match_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_expected integer;
  v_recorded integer;
begin
  v_match := public.lock_match_as_admin(p_match_id);

  -- Idempotent by state, the same way `publish_match()` is: a resubmitted form
  -- returns the match rather than transitioning twice or auditing twice.
  if v_match.status = 'completed' then
    return v_match.id;
  end if;

  if v_match.status = 'canceled' then
    raise exception 'MATCH_NOT_OPEN: a canceled match cannot be completed'
      using errcode = 'P0001';
  end if;

  if now() < v_match.end_at then
    raise exception 'ATTENDANCE_NOT_OPEN: this match has not finished yet'
      using errcode = 'P0001';
  end if;

  select count(*) into v_expected
  from public.match_attendance_population(p_match_id) id;

  select count(*) into v_recorded
  from public.attendance_records a
  where a.match_id = p_match_id
    and a.membership_id in (select id from public.match_attendance_population(p_match_id) id);

  if v_recorded < v_expected then
    raise exception
      'ATTENDANCE_INCOMPLETE: % of % participants still have no attendance recorded',
      v_expected - v_recorded, v_expected
      using errcode = 'P0001';
  end if;

  -- A match nobody was confirmed for completes with an empty register, which is
  -- the honest outcome for a match that never filled.
  update public.matches
     set status = 'completed',
         completed_at = now(),
         completed_by = v_actor
   where id = p_match_id;

  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match', p_match_id, 'match.completed',
    jsonb_build_object('status', v_match.status),
    jsonb_build_object('status', 'completed', 'participants', v_expected),
    null
  );

  return p_match_id;
end;
$$;


-- ── The administrator's attendance workspace ───────────────────────────────
--
-- Everybody who was ever confirmed, their current signup state so the
-- administrator can see who withdrew, and whatever outcome is already recorded.
create or replace function public.match_attendance_workspace(p_match_id uuid)
returns table (
  membership_id uuid,
  first_name text,
  last_name text,
  signup_status public.signup_status,
  canceled_at timestamptz,
  outcome public.attendance_outcome,
  suggested public.attendance_outcome,
  note text,
  revision integer,
  recorded_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.membership_id, p.first_name, p.last_name,
         s.status, s.canceled_at,
         a.outcome,
         public.suggested_attendance_outcome(s.status),
         a.note, a.revision, a.recorded_at
  from public.match_signups s
  join public.matches mt on mt.id = s.match_id
  join public.league_memberships m on m.id = s.membership_id
  join public.profiles p on p.id = m.user_id
  left join public.attendance_records a
    on a.match_id = s.match_id and a.membership_id = s.membership_id
  where s.match_id = p_match_id
    and s.confirmed_at is not null
    and public.is_league_admin(mt.league_id)
  order by a.outcome nulls first, p.first_name, p.last_name;
$$;


-- ── What a player may see about themselves ─────────────────────────────────
--
-- Their own outcome, for one match. There is no parameter for whose attendance
-- to fetch, so asking about somebody else is not expressible.
create or replace function public.my_attendance(p_match_id uuid)
returns table (outcome public.attendance_outcome, recorded_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select a.outcome, coalesce(a.corrected_at, a.recorded_at)
  from public.attendance_records a
  join public.league_memberships m on m.id = a.membership_id
  where a.match_id = p_match_id
    and m.user_id = auth.uid();
$$;

-- Their own history across one league. The administrator's note is absent from
-- the signature, so it cannot travel through it.
create or replace function public.my_attendance_history(p_league_id uuid)
returns table (
  match_id uuid,
  match_title text,
  kickoff_at timestamptz,
  outcome public.attendance_outcome
)
language sql
stable
security definer
set search_path = ''
as $$
  select mt.id, mt.title, mt.kickoff_at, a.outcome
  from public.attendance_records a
  join public.matches mt on mt.id = a.match_id
  join public.league_memberships m on m.id = a.membership_id
  where a.league_id = p_league_id
    and m.user_id = auth.uid()
  order by mt.kickoff_at desc
  limit 50;
$$;


-- ── No-show context for the roster workspace ───────────────────────────────
--
-- The piece Phase 4 deferred. 02 §11 lists "recent attendance count" and a
-- "no-show warning" among the fields an administrator may see while choosing a
-- roster, and Phase 4 shipped the workspace without them because attendance did
-- not exist.
--
-- FACTS ONLY. Three counts and a date, computed live from the current records
-- so a correction is reflected immediately. There is deliberately no threshold,
-- no tier, no colour, no score and no ranking: 04 §1 settled that the product
-- shows warnings and the administrator decides, and no approved document
-- defines a number at which somebody becomes a problem. Inventing one would be
-- inventing a disciplinary policy.
create or replace function public.membership_attendance_summary(
  p_league_id uuid,
  p_membership_ids uuid[]
)
returns table (
  membership_id uuid,
  recorded_count integer,
  attended_count integer,
  no_show_count integer,
  last_no_show_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id,
         count(a.id)::integer,
         count(a.id) filter (where a.outcome = 'attended')::integer,
         count(a.id) filter (where a.outcome = 'no_show')::integer,
         max(mt.kickoff_at) filter (where a.outcome = 'no_show')
  from public.league_memberships m
  left join public.attendance_records a
    on a.membership_id = m.id and a.league_id = p_league_id
  left join public.matches mt on mt.id = a.match_id
  where m.league_id = p_league_id
    and m.id = any(p_membership_ids)
    -- Administrator-only, and only their own league. A player must never be
    -- able to read another player's no-show history.
    and public.is_league_admin(p_league_id)
  group by m.id;
$$;


-- ══ Grants ═════════════════════════════════════════════════════════════════

revoke execute on function public.suggested_attendance_outcome(public.signup_status) from public;
revoke execute on function public.match_accepts_attendance(uuid) from public;
revoke execute on function public.match_attendance_population(uuid) from public;
revoke execute on function public.record_attendance(
  uuid, uuid, public.attendance_outcome, text, integer) from public;
revoke execute on function public.complete_match(uuid) from public;
revoke execute on function public.match_attendance_workspace(uuid) from public;
revoke execute on function public.my_attendance(uuid) from public;
revoke execute on function public.my_attendance_history(uuid) from public;
revoke execute on function public.membership_attendance_summary(uuid, uuid[]) from public;

grant execute on function public.suggested_attendance_outcome(public.signup_status)
  to authenticated, service_role;
grant execute on function public.match_accepts_attendance(uuid) to authenticated, service_role;
grant execute on function public.match_attendance_population(uuid) to service_role;

-- Authorization is inside each function, against auth.uid(), not at the grant.
grant execute on function public.record_attendance(
  uuid, uuid, public.attendance_outcome, text, integer) to authenticated, service_role;
grant execute on function public.complete_match(uuid) to authenticated, service_role;
grant execute on function public.match_attendance_workspace(uuid) to authenticated, service_role;
grant execute on function public.membership_attendance_summary(uuid, uuid[])
  to authenticated, service_role;

grant execute on function public.my_attendance(uuid) to authenticated, service_role;
grant execute on function public.my_attendance_history(uuid) to authenticated, service_role;

-- Matchday — Phase 7B/7C/7G
-- Attendance, and the durable record of who was ever confirmed.


-- ══ The participation marker ═══════════════════════════════════════════════
--
-- WHY A NEW COLUMN. Attendance is about the people who were *confirmed* for a
-- match, and the current signup status cannot answer that: a confirmed player
-- who withdraws ends up `canceled`, which is also where a waitlist-only
-- withdrawal ends up. The two need completely different attendance treatment
-- and are indistinguishable from `status` alone.
--
-- `selected_at` looks like the answer and is not. Tracing every confirmation
-- path:
--
--   join_match()                 first-come — sets selected_at to NULL
--   set_signup_decision()        administrator — sets it
--   add_member_to_match()        manual addition — sets it
--   promote_next_waitlisted()    automatic promotion — sets it
--   promote_waitlisted_player()  administrator promotion — sets it
--
-- and `cancel_spot()` clears it again on withdrawal. Using it would omit every
-- first-come player — the majority of a pickup league — and everybody who
-- cancelled. It means "an administrator chose this person", which is a
-- different fact.
--
-- So: `confirmed_at`, written the first time somebody becomes confirmed by any
-- route, and never cleared. `coalesce` in every writer makes it first-wins, so
-- a player confirmed, dropped and re-confirmed keeps the original instant.
alter table public.match_signups
  add column confirmed_at timestamptz;

comment on column public.match_signups.confirmed_at is
  'When this player first became confirmed for this match, by any route. Never '
  'cleared: it survives cancellation, which is what makes "who was expected to '
  'play?" answerable after the fact. Distinct from selected_at, which records '
  'an administrator decision and is NULL for first-come joins.';

-- Backfill. Anybody currently confirmed plainly was; `selected_at` is the best
-- available instant for the administrator-driven paths, and `responded_at` for
-- the rest. Historical rows that were confirmed and later cancelled cannot be
-- recovered — the information was never recorded — so they are left NULL and
-- simply do not appear in attendance for those past matches.
update public.match_signups
   set confirmed_at = coalesce(selected_at, responded_at)
 where public.signup_consumes_capacity(status)
   and confirmed_at is null;

-- SET BY A TRIGGER, not by the five confirming functions.
--
-- A trigger because the alternative is editing `join_match()`,
-- `set_signup_decision()`, `add_member_to_match()`, `promote_next_waitlisted()`
-- and `promote_waitlisted_player()` and trusting that the sixth confirmation
-- path somebody writes next year remembers to do the same. The invariant is
-- "a confirmed row has a confirmed_at", and that is a property of the row, so
-- the row is where it belongs.
--
-- `coalesce` makes it first-wins: somebody confirmed, dropped and re-confirmed
-- keeps the instant they were first counted on.
create or replace function public.match_signups_stamp_confirmed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.signup_consumes_capacity(new.status) then
    new.confirmed_at := coalesce(new.confirmed_at, now());
  end if;

  return new;
end;
$$;

create trigger match_signups_stamp_confirmed_at
  before insert or update of status on public.match_signups
  for each row execute function public.match_signups_stamp_confirmed_at();

revoke execute on function public.match_signups_stamp_confirmed_at() from public;


-- The attendance population, in one place so nothing restates it.
--
-- Membership status is deliberately *not* filtered here: somebody suspended
-- after the match still played in it, and an administrator recording attendance
-- for last week must still see them.
create or replace function public.match_attendance_population(p_match_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.membership_id
  from public.match_signups s
  where s.match_id = p_match_id
    and s.confirmed_at is not null;
$$;

comment on function public.match_attendance_population(uuid) is
  'Memberships eligible for an attendance record: everybody who was ever '
  'confirmed for this match, including those who later cancelled. Waitlist-only '
  'withdrawals, interested-only and not-selected players are absent.';


-- ══ Attendance ═════════════════════════════════════════════════════════════

-- The five outcomes from 02 §16, exactly.
create type public.attendance_outcome as enum (
  'attended',
  'excused_absence',
  'canceled_on_time',
  'canceled_late',
  'no_show'
);

create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),

  league_id uuid not null references public.leagues (id) on delete cascade,
  match_id uuid not null,
  membership_id uuid not null,

  outcome public.attendance_outcome not null,

  /** Administrator-only. Never shown to the player, never pushed, never audited. */
  note text,

  /**
   * Bumped by every correction. Part of the notification key, so a correction
   * tells the player again while a retry of the same write does not, and the
   * basis of the stale-write check.
   */
  revision integer not null default 1,

  recorded_by uuid references public.profiles (id) on delete set null,
  recorded_at timestamptz not null default now(),
  corrected_by uuid references public.profiles (id) on delete set null,
  corrected_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One current record per player per match (02 §16). Corrections update this
  -- row; the history lives in audit_events, which is append-only.
  constraint attendance_records_match_membership_key unique (match_id, membership_id),

  constraint attendance_records_revision_positive check (revision >= 1),
  constraint attendance_records_note_length
    check (note is null or char_length(btrim(note)) between 1 and 1000),
  -- Correction metadata is all-or-nothing, so "who changed this?" can never be
  -- half-answered.
  constraint attendance_records_correction_consistent
    check ((corrected_by is null) = (corrected_at is null)),

  -- Both composite keys carry league_id, so an attendance record spanning two
  -- tenants is unrepresentable rather than merely rejected.
  constraint attendance_records_match_fk
    foreign key (match_id, league_id)
    references public.matches (id, league_id) on delete cascade,
  constraint attendance_records_membership_fk
    foreign key (membership_id, league_id)
    references public.league_memberships (id, league_id) on delete cascade
);

create index attendance_records_match_idx on public.attendance_records (match_id);
create index attendance_records_league_idx on public.attendance_records (league_id);
-- The no-show summary the roster workspace reads, kept small by the predicate.
create index attendance_records_no_show_idx
  on public.attendance_records (membership_id)
  where outcome = 'no_show';

create trigger attendance_records_set_updated_at
  before update on public.attendance_records
  for each row execute function public.set_updated_at();

comment on table public.attendance_records is
  'One current attendance outcome per confirmed participant per match. '
  'Corrections update the row and bump `revision`; the prior value survives in '
  'audit_events, which is never rewritten.';


-- ══ Completion ═════════════════════════════════════════════════════════════
--
-- `completed` has been declared in `match_lifecycle_status` since Phase 3 and
-- unreachable ever since. Phase 7 implements it — and only it.
--
-- `teams_published` stays unreachable on purpose. Phase 6 settled that team
-- publication is metadata (`team_revision`, `teams_published_at`) rather than a
-- lifecycle state, because moving a match into `teams_published` would close
-- first-come signup and stop `finalize_roster()` accepting it. Nothing in Phase
-- 7 changes that reasoning, so the enum value stays a name without a state.
create or replace function public.matches_guard_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if (old.status = 'draft' and new.status in ('open', 'canceled'))
     or (old.status = 'open' and new.status in ('roster_finalized', 'canceled', 'completed'))
     -- A finalized roster can be reopened for further changes, canceled
     -- outright, or played and completed.
     or (old.status = 'roster_finalized'
         and new.status in ('open', 'canceled', 'completed'))
  then
    return new;
  end if;

  raise exception 'MATCH_TRANSITION_INVALID: cannot move a match from % to %',
    old.status, new.status
    using errcode = '23514';
end;
$$;

-- When the match was completed, and by whom. `completed_at` is the authoritative
-- signal for the mutation guards below; the status mirrors it.
alter table public.matches
  add column completed_at timestamptz,
  add column completed_by uuid references public.profiles (id) on delete set null;

alter table public.matches
  add constraint matches_completed_consistent
    check ((status = 'completed') = (completed_at is not null));


-- ══ Membership status history ══════════════════════════════════════════════
--
-- A suspension or removal needs a reason (7L), and the reason is administrative
-- free text about a person — so it lives beside the membership rather than in
-- an audit event, for the same reason `league_membership_admin_notes` does.
--
-- NOTE ON `suspended_until`. It has existed since Phase 1 with a CHECK tying it
-- to `status = 'suspended'` and a trigger clearing it when the status moves.
-- Nothing expires it: there is no job that reactivates anybody, and none is
-- added here. It is informational — a note of when the administrator intends to
-- lift the suspension — and reactivation stays a deliberate manual act. That is
-- the smallest internally consistent behaviour, and inventing automatic
-- expiry would mean a member silently regaining access with nobody deciding it.
alter table public.league_memberships
  add column status_reason text;

alter table public.league_memberships
  add constraint league_memberships_status_reason_length
    check (status_reason is null or char_length(btrim(status_reason)) between 1 and 500);

comment on column public.league_memberships.status_reason is
  'Why the administrator last suspended, removed or reactivated this member. '
  'Administrator-only: never shown to other players, never pushed, never '
  'placed in application logs.';

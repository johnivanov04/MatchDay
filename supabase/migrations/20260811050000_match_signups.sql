-- Matchday — Phase 4A
-- One player's response to one match.
--
-- Everything else in Phase 4 is a projection of this table: the confirmed
-- roster, the ordered waitlist, the derived needs_players/enough_players/full
-- labels, and the administrator workspace are all reads of these rows. That is
-- why the invariants live here as constraints rather than in the functions that
-- write them — a function can be bypassed by a future function, a constraint
-- cannot.


-- All seven values from 02 §3. `canceled` and `withdrawn_late` are declared now
-- because Phase 5 needs them and adding an enum value later is a schema change
-- on a table that will by then hold production rows. No Phase 4 code writes
-- either one; the transition guard below is what keeps them unreachable.
create type public.signup_status as enum (
  'interested',
  'confirmed',
  'waitlisted',
  'not_selected',
  'not_available',
  'canceled',
  'withdrawn_late'
);


-- ── Which statuses consume a capacity slot ─────────────────────────────────
--
-- One definition, used by the counting query, the partial index and the tests,
-- so "what counts against capacity" cannot drift between them.
--
-- Only `confirmed` consumes. `interested` deliberately does not: in an
-- admin_approval match the roster is *selected from* the interested players, so
-- if a request consumed a slot the match would report itself full before the
-- administrator had decided anything. `waitlisted` is by definition the people
-- who did not get a slot, and the remaining four are all forms of "not playing".
create or replace function public.signup_consumes_capacity(p_status public.signup_status)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_status = 'confirmed';
$$;

comment on function public.signup_consumes_capacity(public.signup_status) is
  'The single definition of which signup statuses occupy a capacity slot. '
  'Used by capacity counting, the confirmed-roster index and the test suite.';


-- ── The table ──────────────────────────────────────────────────────────────

create table public.match_signups (
  id uuid primary key default gen_random_uuid(),

  league_id uuid not null references public.leagues (id) on delete cascade,
  match_id uuid not null,
  membership_id uuid not null,

  status public.signup_status not null,

  -- When the player (or the administrator acting for them) last responded.
  -- Ordering the administrator workspace by this is what makes "first come"
  -- legible after the fact.
  responded_at timestamptz not null default now(),

  -- Whether this response landed inside the match's priority window. Nullable
  -- because a match need not have one; never a player-supplied value.
  priority_qualified boolean,

  -- Present exactly when waitlisted — see the CHECK below.
  waitlist_position integer,

  -- Reserved for Phase 5. Declared so the cancellation workflow does not need a
  -- migration on a populated table, and constrained so no Phase 4 path can
  -- half-populate them.
  canceled_at timestamptz,
  cancellation_reason text,

  -- Who made an administrator decision, and when. Both or neither.
  selected_by uuid references public.profiles (id) on delete set null,
  selected_at timestamptz,

  -- Required whenever an administrator bypasses an overrideable rule.
  override_reason text,

  -- The status this player was last *told*, at the last roster publication.
  -- NULL until the roster has been published at all.
  --
  -- This is what makes "affected player" well defined. Without it, a
  -- republication either notifies everybody again — training people to ignore
  -- the notification that matters — or notifies nobody, and a player moved off
  -- the roster never finds out. Comparing `status` against it answers "did this
  -- person's outcome actually change?" without keeping a second history table.
  published_status public.signup_status,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One signup per player per match (02 §19). This is also what makes every
  -- signup operation idempotent: a repeated tap collides here and is resolved
  -- as an update of the caller's own row rather than a second one.
  constraint match_signups_match_membership_key unique (match_id, membership_id),

  -- A child row cannot name a match in one league and a membership in another:
  -- both composite keys carry league_id, so a cross-tenant signup is not
  -- representable rather than merely rejected by application code.
  constraint match_signups_match_fk
    foreign key (match_id, league_id)
    references public.matches (id, league_id) on delete cascade,
  constraint match_signups_membership_fk
    foreign key (membership_id, league_id)
    references public.league_memberships (id, league_id) on delete cascade,

  -- A waitlist position belongs to a waitlisted player and to nobody else.
  -- Without both halves, a promoted player could keep their old position and
  -- silently occupy a slot in the ordering.
  constraint match_signups_waitlist_position_iff_waitlisted
    check ((status = 'waitlisted') = (waitlist_position is not null)),
  constraint match_signups_waitlist_position_positive
    check (waitlist_position is null or waitlist_position >= 1),

  -- DEFERRABLE, and that is load-bearing. Reordering a waitlist is a
  -- permutation, so any statement order will collide part-way through unless
  -- the check is postponed to COMMIT. A partial unique *index* cannot be
  -- deferred; a table constraint can, and since waitlist_position is NULL for
  -- every non-waitlisted row (enforced above) and NULLs never conflict, a plain
  -- UNIQUE gives exactly the intended "unique among waitlisted rows".
  constraint match_signups_waitlist_position_key
    unique (match_id, waitlist_position) deferrable initially immediate,

  -- Administrator decision metadata is all-or-nothing, so "who chose this?"
  -- can never be half-answered.
  constraint match_signups_selection_metadata_consistent
    check ((selected_by is null) = (selected_at is null)),

  constraint match_signups_override_reason_length
    check (override_reason is null
           or char_length(btrim(override_reason)) between 1 and 500),
  constraint match_signups_cancellation_reason_length
    check (cancellation_reason is null
           or char_length(btrim(cancellation_reason)) between 1 and 500),

  -- Phase 5 fields stay inert. A cancellation timestamp may only exist on a
  -- canceled status, and a reason may only exist alongside a timestamp, so no
  -- Phase 4 path can leave a row that looks half-canceled.
  constraint match_signups_cancellation_fields_reserved
    check (
      (canceled_at is null and cancellation_reason is null)
      or (status in ('canceled', 'withdrawn_late') and canceled_at is not null)
    )
);


-- The confirmed roster, and the capacity count taken under lock. Partial, so it
-- stays the size of the roster rather than the size of the response list.
create index match_signups_confirmed_idx
  on public.match_signups (match_id)
  where public.signup_consumes_capacity(status);

-- The ordered waitlist, which is always read in position order.
create index match_signups_waitlist_idx
  on public.match_signups (match_id, waitlist_position)
  where status = 'waitlisted';

-- "Every match I have responded to", for the player's own views.
create index match_signups_membership_idx
  on public.match_signups (membership_id, match_id);

create index match_signups_league_idx on public.match_signups (league_id);

create trigger match_signups_set_updated_at
  before update on public.match_signups
  for each row execute function public.set_updated_at();

comment on table public.match_signups is
  'One player''s response to one match. The confirmed roster, the ordered '
  'waitlist and the derived participation labels are all projections of this '
  'table. Capacity is claimed under a row lock on the match — see join_match().';

comment on column public.match_signups.waitlist_position is
  'Sequential from 1, unique within a match, present only while waitlisted. '
  'A player may read their own; only an administrator may read the ordering.';


-- ── Status transition guard ────────────────────────────────────────────────
--
-- Same shape as matches_guard_status_transition(): the enum names seven states
-- and Phase 4 implements five, so the two Phase 5 states are allowlisted out
-- rather than left quietly reachable. A Phase 4 bug that wrote `canceled` would
-- otherwise free a capacity slot with none of the cancellation behaviour —
-- no receipt, no promotion, no late classification — which is precisely the
-- half-implemented state this guard exists to prevent.
create or replace function public.match_signups_guard_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status in ('canceled', 'withdrawn_late') then
    raise exception
      'SIGNUP_TRANSITION_INVALID: cancellation is not implemented yet (Phase 5)'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger match_signups_guard_status
  before insert or update of status on public.match_signups
  for each row execute function public.match_signups_guard_status();


-- ── Roster revision on the match ───────────────────────────────────────────
--
-- Separate from `matches.revision`, which Phase 3B uses for edits to the match
-- itself and which is part of the `match_changed:<match>:<revision>`
-- notification key. Sharing one counter would make a roster publication
-- suppress a genuine match-edit notification, or the reverse. 02 §17 lists
-- roster and team revisions as distinct fields for the same reason.
alter table public.matches
  add column roster_revision integer not null default 0,
  add column roster_finalized_at timestamptz;

alter table public.matches
  add constraint matches_roster_revision_non_negative check (roster_revision >= 0);

comment on column public.matches.roster_revision is
  'Incremented by each roster publication. Part of the roster_published '
  'notification key, and distinct from `revision`, which tracks edits to the '
  'match itself.';


-- ── Lifecycle: open → roster_finalized ─────────────────────────────────────
--
-- The Phase 3 guard allowlisted three transitions and left a comment saying
-- Phase 4 adds this one. Replacing the function rather than the enum is the
-- pattern that comment describes.
create or replace function public.matches_guard_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  -- Phase 6 adds roster_finalized → teams_published, Phase 7 adds → completed.
  if (old.status = 'draft' and new.status in ('open', 'canceled'))
     or (old.status = 'open' and new.status in ('roster_finalized', 'canceled'))
     -- A finalized roster can be reopened for further changes, which is how a
     -- late drop-out is handled before Phase 5 exists, and can still be
     -- canceled outright.
     or (old.status = 'roster_finalized' and new.status in ('open', 'canceled'))
  then
    return new;
  end if;

  raise exception 'MATCH_TRANSITION_INVALID: cannot move a match from % to %',
    old.status, new.status
    using errcode = '23514';
end;
$$;

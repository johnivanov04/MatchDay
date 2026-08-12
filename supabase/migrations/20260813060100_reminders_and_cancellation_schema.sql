-- Matchday — Phase 5A/5J
-- Schema for cancellation and for reminders.
--
-- Two things happen here: the Phase 4 guard that made cancellation
-- unreachable is relaxed to permit exactly the transitions Phase 5 implements,
-- and reminders get a durable home.


-- ── Activating the cancellation statuses ───────────────────────────────────
--
-- Phase 4 refused `canceled` and `withdrawn_late` outright, because writing one
-- would have freed a capacity slot with none of the behaviour behind it: no
-- receipt, no promotion, no late classification. All of that now exists, so the
-- guard narrows from "never" to "only through cancel_spot()".
--
-- The check is on the *shape* of the row rather than on which function wrote
-- it. A cancellation status must carry a cancellation timestamp and must not
-- hold a waitlist position, which is precisely what a half-applied cancellation
-- would leave behind.
create or replace function public.match_signups_guard_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status in ('canceled', 'withdrawn_late') then
    if new.canceled_at is null then
      raise exception
        'SIGNUP_TRANSITION_INVALID: a cancellation must record when it happened'
        using errcode = '23514';
    end if;

    -- Belt and braces: the table constraint already forbids a waitlist
    -- position on a non-waitlisted row, and this says why it matters here.
    if new.waitlist_position is not null then
      raise exception
        'SIGNUP_TRANSITION_INVALID: a canceled signup cannot hold a waitlist place'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;


-- ── Reminder configuration on the match ────────────────────────────────────
--
-- `match_templates.reminder_offsets` has existed since Phase 3 as
-- future-compatible metadata. A match needs its own copy for the same reason it
-- carries its own resolved timestamps rather than re-deriving them: editing a
-- template must never silently move the reminders of a match people have
-- already signed up for.
alter table public.matches
  add column reminder_offsets interval[] not null default '{}'::interval[];

alter table public.matches
  add constraint matches_reminder_offsets_valid check (
    array_length(reminder_offsets, 1) is null
    or (
      array_length(reminder_offsets, 1) <= 5
      and array_position(reminder_offsets, null::interval) is null
    )
  );

comment on column public.matches.reminder_offsets is
  'How far before kickoff to remind confirmed players. Copied from the template '
  'at creation; publishing resolves each one into a concrete match_reminders row.';


-- ── Reminders ──────────────────────────────────────────────────────────────
--
-- One row per match per offset, holding a concrete instant.
--
-- Storing the resolved `due_at` rather than recomputing `kickoff_at - offset`
-- at scan time is the same decision Phase 3 made for match times, for the same
-- reason: a scheduler that re-derived the due time would disagree with itself
-- across a daylight-saving transition, and "did this reminder already go out?"
-- must have one answer.
--
-- `generated_at` is the claim marker. It is what makes running the generator
-- twice — by two workers, or by a retry after a timeout — produce one round of
-- notifications rather than two.
create table public.match_reminders (
  id uuid primary key default gen_random_uuid(),

  league_id uuid not null references public.leagues (id) on delete cascade,
  match_id uuid not null,

  /** How far before kickoff this reminder was configured for. */
  offset_before interval not null,
  /** The resolved instant, from the match's own stored kickoff. */
  due_at timestamptz not null,

  /** Set when the generator claims this row. NULL means still pending. */
  generated_at timestamptz,
  /** How many canonical notifications the claim produced, for observability. */
  notified_count integer,

  created_at timestamptz not null default now(),

  -- One reminder per match per offset. Re-publishing a match cannot create a
  -- second copy of the same reminder.
  constraint match_reminders_match_offset_key unique (match_id, offset_before),

  constraint match_reminders_match_fk
    foreign key (match_id, league_id)
    references public.matches (id, league_id) on delete cascade,

  constraint match_reminders_offset_positive check (offset_before > interval '0'),
  constraint match_reminders_generated_consistent
    check ((generated_at is null) = (notified_count is null))
);

-- The generator's only query: pending rows that are due, oldest first.
create index match_reminders_due_idx
  on public.match_reminders (due_at)
  where generated_at is null;

create index match_reminders_match_idx on public.match_reminders (match_id);

comment on table public.match_reminders is
  'One pending or sent reminder occurrence. `generated_at` is the claim marker '
  'that makes repeated generator runs idempotent; the notification idempotency '
  'key is the second line of defence.';

-- Matchday — defect found by Phase 7
-- A player who cancels can never get back into that match.
--
-- THE DEFECT. `cancel_spot()` sets `canceled_at` and `cancellation_reason`, and
-- `match_signups_cancellation_fields_reserved` requires that a row carrying
-- those fields is `canceled` or `withdrawn_late`. No re-confirmation path clears
-- them, so every route back in fails on the constraint:
--
--   join_match()                 player changes their mind      → 23514
--   add_member_to_match()        administrator re-adds them     → 23514
--   set_signup_decision()        administrator confirms them    → 23514
--   promote_waitlisted_player()  administrator promotes them    → 23514
--
-- Which makes a cancellation permanent, in a product whose entire subject is
-- people dropping in and out of pickup matches. "I cancelled, then my evening
-- freed up" is not an edge case for a five-a-side league; it is Tuesday.
--
-- The constraint is right and stays. What was missing is the other half of the
-- rule it encodes: fields that belong to a cancellation must be cleared when the
-- row stops being a cancellation.
--
-- FIXED IN A TRIGGER, not in the four functions, for the reason `confirmed_at`
-- is a trigger: "a non-cancelled row carries no cancellation fields" is a
-- property of the row. Putting it in the four writers would leave the fifth one
-- somebody adds later to rediscover this by hitting the constraint in
-- production.
--
-- `confirmed_at` is emphatically NOT cleared here. That it survives a
-- cancellation is what makes the attendance population answerable — see
-- 20260817080100.

create or replace function public.match_signups_stamp_confirmed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.signup_consumes_capacity(new.status) then
    -- First-wins: somebody confirmed, dropped and re-confirmed keeps the instant
    -- they were first counted on.
    new.confirmed_at := coalesce(new.confirmed_at, now());
  end if;

  -- Leaving a cancelled state clears what the cancellation wrote. The audit
  -- event and the notification are the durable record that it happened; these
  -- two columns only ever describe the row's *current* state, and the check
  -- constraint says so.
  if new.status not in ('canceled', 'withdrawn_late') then
    new.canceled_at := null;
    new.cancellation_reason := null;
  end if;

  return new;
end;
$$;

-- The trigger fired only on `update of status`, which was enough for
-- `confirmed_at` but not for this: `cancel_spot()` writes `status` and
-- `canceled_at` together, and a later path might clear a status without
-- naming the column in its SET list. Firing on every update costs one function
-- call per signup write and removes a whole class of way to get this wrong.
drop trigger if exists match_signups_stamp_confirmed_at on public.match_signups;

create trigger match_signups_stamp_confirmed_at
  before insert or update on public.match_signups
  for each row execute function public.match_signups_stamp_confirmed_at();

comment on function public.match_signups_stamp_confirmed_at() is
  'Keeps two row-level invariants that no writer should have to remember: a '
  'confirmed row has a confirmed_at (set once, never cleared), and a row that '
  'is not a cancellation carries no cancellation fields.';

-- Existing rows cannot be inconsistent — the constraint has been in force since
-- Phase 4 and would have rejected them — so there is nothing to backfill.

-- Matchday — Phase 5L
-- Whether cancelling *now* would be late, answered by the database.
--
-- The interface has to warn a player before they press the button, which means
-- comparing the cutoff against a clock. Doing that in the page would use the
-- rendering server's clock while `cancel_spot()` uses the database's — two
-- clocks that agree until they do not, and the moment they disagree the
-- interface promises "on time" and the record says otherwise.
--
-- So the same `now()` that classifies the cancellation answers the question.
-- The flag is presentation only; it is never submitted and never trusted.
--
-- Dropped first: PostgreSQL refuses to change the return type of an existing
-- function through `create or replace`, and two extra output columns is a
-- changed return type.
drop function if exists public.match_signup_counts(uuid);

create or replace function public.match_signup_counts(p_match_id uuid)
returns table (
  confirmed integer,
  waitlisted integer,
  interested integer,
  capacity integer,
  min_players integer,
  cancellation_cutoff_at timestamptz,
  cancellation_is_late boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    count(*) filter (where public.signup_consumes_capacity(s.status))::integer,
    count(*) filter (where s.status = 'waitlisted')::integer,
    count(*) filter (where s.status = 'interested')::integer,
    mt.capacity,
    mt.min_players,
    mt.cancellation_cutoff_at,
    -- Inclusive boundary: cancelling *at* the cutoff is on time, matching
    -- cancel_spot(). Note this rounds the opposite way from signup_closes_at,
    -- where Phase 3 treats `now() >= signup_closes_at` as closed.
    now() > mt.cancellation_cutoff_at
  from public.matches mt
  left join public.match_signups s on s.match_id = mt.id
  where mt.id = p_match_id
    and mt.published_at is not null
    and (public.is_active_member(mt.league_id) or public.is_league_admin(mt.league_id))
  group by mt.capacity, mt.min_players, mt.cancellation_cutoff_at;
$$;

-- `create or replace` on a changed signature creates a NEW function, which
-- arrives with PostgreSQL's built-in EXECUTE-to-PUBLIC default.
revoke execute on function public.match_signup_counts(uuid) from public;
grant execute on function public.match_signup_counts(uuid) to authenticated, service_role;

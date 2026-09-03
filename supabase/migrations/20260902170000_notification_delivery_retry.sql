-- MatchDay — Phase 3C: retrying a provider that said "not now".
--
-- ── WHAT 3B LEFT UNDONE ────────────────────────────────────────────────────
--
-- Phase 3B gave every notification a durable delivery job and a worker to drain
-- it, but the worker had exactly one response to a provider failure: record the
-- category and finish. `classify.ts` has always been able to tell a rate limit
-- from a dead device token — `temporary_failure` versus `permanent_failure` and
-- `invalidated` — and nothing ever acted on the distinction. APNs answering
-- `TooManyRequests` for two seconds meant a match alert was silently dropped.
--
-- ── THE TWO COUNTERS ARE NOT THE SAME COUNTER ──────────────────────────────
--
-- `attempts` counts CLAIMS. It is incremented by `claim_notification_delivery_jobs`
-- every time a worker picks the job up, including when the pick-up is a lease
-- reclaim after a worker was killed mid-batch. A job can therefore reach
-- `attempts = 4` having never once reached a push provider.
--
-- `provider_attempts` counts PROVIDER DELIVERY ROUNDS that ended in a retryable
-- failure. Only `reschedule_notification_delivery_job` increments it, and only
-- when the worker actually got a temporary failure back from a provider.
--
-- Spending the retry budget on crash recovery would mean a bad deploy — three
-- restarts, three reclaims — quietly exhausting the retries for every notification
-- in flight, and none of them would ever be delivered. So the budget is its own
-- column and lease recovery cannot touch it.
--
-- ── WHY THE POLICY LIVES HERE AND NOT IN THE WORKER ─────────────────────────
--
-- The worker does not compute the delay and does not decide when the budget is
-- spent. It reports "this round hit a retryable failure" and the database
-- answers with either a new eligibility time or a terminal state, in one
-- statement, under the row's own lock.
--
-- That keeps two workers racing on the same job from computing two different
-- schedules, and it means the retry policy is one thing in one place rather
-- than a constant in TypeScript and a column in Postgres that can drift.
--
--   1st temporary failure →  +1 minute
--   2nd                   →  +2 minutes
--   3rd                   →  +5 minutes
--   4th                   → +15 minutes
--   5th                   → terminal `failed`, category `retries_exhausted`
--
-- At most FIVE provider delivery rounds. No jitter: the fleet is one cron on a
-- one-minute tick, so there is no thundering herd to spread out, and a
-- deterministic schedule is one a test can assert exactly.
--
-- ── WHAT IS STILL NOT RETRIED ──────────────────────────────────────────────
--
-- `permanent_failure` and `invalidated` are terminal per (notification,
-- subscription) and always were — `alreadyDelivered` in `push-store.ts` has
-- skipped them since Phase 3. Retrying a dead device token achieves nothing but
-- load. A notification with no enabled subscriptions is `completed`, not
-- retried: there is nothing owed and no amount of waiting creates a device.


-- ── Scheduling ─────────────────────────────────────────────────────────────

alter table public.notification_delivery_jobs
  -- NOT NULL with `now()`. Every job that already exists becomes immediately
  -- claimable, which is what makes this migration invisible to the Phase 3B
  -- worker running against it during the deploy window.
  add column next_attempt_at timestamptz not null default now(),

  -- Provider rounds that ended retryable. See the header: deliberately not
  -- `attempts`.
  add column provider_attempts integer not null default 0;

alter table public.notification_delivery_jobs
  add constraint notification_delivery_jobs_provider_attempts_non_negative
    check (provider_attempts >= 0);

comment on column public.notification_delivery_jobs.next_attempt_at is
  'Earliest time this job may be claimed. Provider backoff only — lease reclaim '
  'of a crashed worker ignores it.';

comment on column public.notification_delivery_jobs.provider_attempts is
  'Provider delivery rounds that ended in a retryable failure. NOT the claim '
  'count — see attempts.';


-- The pending index now has to answer "due yet?", not merely "pending?".
-- Replaced rather than added to: an index on `created_at` that the claim no
-- longer orders by would be dead weight on every insert.
drop index if exists notification_delivery_jobs_pending_idx;

create index notification_delivery_jobs_pending_idx
  on public.notification_delivery_jobs (next_attempt_at)
  where status = 'pending';


-- ── Claim, now time-aware ──────────────────────────────────────────────────
--
-- CREATE OR REPLACE, and the signature is untouched — `RETURNS TABLE` is
-- unchanged, so this is a body swap. That matters more than it looks: the
-- Phase 3B worker is still serving production when this migration lands, and it
-- calls this function by exactly this signature. Changing the shape would have
-- meant a DROP, a window with no function, and PGRST202 in production.
--
-- Two branches, deliberately asymmetric:
--
--   • pending      → must also be DUE (`next_attempt_at <= now()`)
--   • processing   → lease expired, reclaimed regardless of `next_attempt_at`
--
-- The asymmetry is the point. A crashed worker's job is not waiting on a
-- provider backoff; it is waiting on somebody to notice the worker is gone.
create or replace function public.claim_notification_delivery_jobs(
  p_worker text,
  p_limit integer default 25,
  p_lease_seconds integer default 120
)
returns table (
  job_id uuid,
  job_notification_id uuid,
  job_attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 120), 10), 900);
begin
  if coalesce(auth.role(), 'service_role') <> 'service_role' then
    raise exception 'NOT_AUTHORIZED: notification delivery is a server-side operation'
      using errcode = '42501';
  end if;

  if p_worker is null or p_worker !~ '^[A-Za-z0-9._:-]{1,64}$' then
    raise exception 'INVALID_WORKER: worker identity must be a short opaque token'
      using errcode = '22023';
  end if;

  return query
  with claimable as (
    select j.id
    from public.notification_delivery_jobs j
    where (j.status = 'pending' and j.next_attempt_at <= now())
       or (j.status = 'processing' and j.lease_expires_at < now())
    -- Oldest eligible first. Ordering by `next_attempt_at` rather than
    -- `created_at` keeps a long-backed-off job from starving fresh work.
    order by j.next_attempt_at
    limit v_limit
    for update skip locked
  )
  update public.notification_delivery_jobs j
     set status = 'processing',
         attempts = j.attempts + 1,
         claimed_at = now(),
         claimed_by = p_worker,
         lease_expires_at = now() + make_interval(secs => v_lease),
         updated_at = now()
    from claimable c
   where j.id = c.id
  returning j.id, j.notification_id, j.attempts;
end;
$$;


-- ── Reschedule, or give up ─────────────────────────────────────────────────
--
-- Called when a delivery round left at least one subscription in a retryable
-- state. Decides, atomically, whether that earns another round or ends the job.
--
-- Returns what it did so the worker can log it without having to re-read the
-- row and guess.
create function public.reschedule_notification_delivery_job(
  p_job_id uuid,
  p_error_category text default null
)
returns table (
  outcome text,
  retry_number integer,
  scheduled_for timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.notification_delivery_jobs;
  v_next integer;
  v_delay interval;
begin
  if coalesce(auth.role(), 'service_role') <> 'service_role' then
    raise exception 'NOT_AUTHORIZED: notification delivery is a server-side operation'
      using errcode = '42501';
  end if;

  -- Locked, so two workers cannot both decide this job's fate. Only a job this
  -- worker still holds may be rescheduled: `processing` is the claim, and a job
  -- that has already reached a terminal state is not reopened by a straggler.
  select * into v_job
  from public.notification_delivery_jobs j
  where j.id = p_job_id and j.status = 'processing'
  for update;

  if not found then
    outcome := 'not_claimed';
    retry_number := null;
    scheduled_for := null;
    return next;
    return;
  end if;

  v_next := v_job.provider_attempts + 1;

  -- THE BUDGET. Five temporary failures is the whole allowance, so the fifth
  -- one ends the job rather than buying a sixth round.
  v_delay := case v_next
               when 1 then interval '1 minute'
               when 2 then interval '2 minutes'
               when 3 then interval '5 minutes'
               when 4 then interval '15 minutes'
               else null
             end;

  if v_delay is null then
    update public.notification_delivery_jobs j
       set status = 'failed',
           provider_attempts = v_next,
           completed_at = now(),
           lease_expires_at = null,
           -- Distinguishable from a permanent provider refusal and from an
           -- internal dispatch fault. An operator reading this column can tell
           -- "the provider kept saying try later and we stopped trying" from
           -- "the provider said never".
           last_error_category = 'retries_exhausted',
           updated_at = now()
     where j.id = p_job_id;

    outcome := 'exhausted';
    retry_number := v_next;
    scheduled_for := null;
    return next;
    return;
  end if;

  update public.notification_delivery_jobs j
     set status = 'pending',
         provider_attempts = v_next,
         next_attempt_at = now() + v_delay,
         -- The claim is released. `claimed_at`/`claimed_by` are left as the
         -- historical record of who last held it; the lease is what governs
         -- ownership, and this job is nobody's until it is due again.
         lease_expires_at = null,
         last_error_category = p_error_category,
         updated_at = now()
   where j.id = p_job_id;

  outcome := 'scheduled';
  retry_number := v_next;
  scheduled_for := now() + v_delay;
  return next;
end;
$$;


-- ── Execution ──────────────────────────────────────────────────────────────
--
-- The same treatment 20260805030900 established and 20260901120000 followed: a
-- freshly created function is EXECUTE-able by PUBLIC until told otherwise, and
-- `tests/db/schema.test.ts` holds the whole schema to that rule.
revoke execute on function public.reschedule_notification_delivery_job(uuid, text) from public;
grant execute on function public.reschedule_notification_delivery_job(uuid, text) to service_role;

-- Unchanged in signature, but a replaced function keeps its existing ACL, so
-- this is belt and braces rather than a fix.
revoke execute on function public.claim_notification_delivery_jobs(text, integer, integer) from public;
grant execute on function public.claim_notification_delivery_jobs(text, integer, integer) to service_role;

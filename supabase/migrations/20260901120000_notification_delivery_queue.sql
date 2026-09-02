-- MatchDay — Phase 3B: a durable queue between a notification and its push.
--
-- ── WHAT THIS CHANGES ──────────────────────────────────────────────────────
--
-- Before: an administrator published a match, and the server action then sat
-- there — inside the request — talking to APNs and Web Push once per device of
-- every member of the league. The publication was already committed, so none of
-- that could change the outcome; it only decided how long the administrator
-- stared at a spinner. A slow provider made a successful edit feel broken, and
-- a fanout large enough to hit the function's wall clock got cut off partway
-- with no record of where it stopped.
--
-- After: the notification row and a delivery job commit together, the request
-- returns, and a worker drains the queue.
--
-- ── WHY A TRIGGER, AND NOT AN ENQUEUE CALL ─────────────────────────────────
--
-- The obvious shape is for each server action to insert a job after its domain
-- call returns. That reintroduces the exact window this phase exists to close:
-- the notification commits in one transaction, the job in another, and a
-- process that dies in between leaves a notification nobody will ever deliver.
--
-- An AFTER INSERT trigger runs inside the *same* transaction as the notification
-- insert. Either both rows commit or neither does. There is no window, and no
-- application code has to remember anything.
--
-- It also closes a gap that was already live. `decide_join_request` writes
-- `join_request_approved` / `join_request_rejected` with `push_eligible: true`,
-- both are in `PUSH_ELIGIBLE_TYPES`, and `src/server/actions/membership.ts` —
-- alone among the fanout actions — never called the push seam. Approving
-- somebody into a league has therefore never lit up their phone. Driving the
-- queue from the notification rows rather than from call sites fixes that
-- without a sixth place to forget.
--
-- ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
--
-- No retry policy, no backoff, no dead-letter escalation. A provider that
-- answers `temporary_failure` is recorded and left alone; Phase 3C owns that.
--
-- The one recovery mechanism present is the lease, and it exists for a
-- different failure: a worker that is killed mid-batch — a redeploy, a
-- function timeout, an instance reclaimed — would otherwise leave its jobs in
-- `processing` for ever. That is not provider retry, it is a crashed process,
-- and a queue that strands work when a worker disappears is not a working
-- queue. The two are kept distinct in every name and comment.


-- ── The job's own lifecycle ────────────────────────────────────────────────
--
-- Deliberately four states and not more. `pending` and `processing` are the
-- claim; `completed` and `failed` are terminal and never re-enter the queue.
create type public.notification_delivery_job_status as enum (
  'pending',
  'processing',
  'completed',
  'failed'
);


create table public.notification_delivery_jobs (
  id uuid primary key default gen_random_uuid(),

  -- ONE JOB PER NOTIFICATION, and the unique constraint is the whole
  -- idempotency story on the enqueue side. `create_notification` already
  -- inserts `on conflict (idempotency_key) do nothing`, so a retried domain
  -- operation writes no notification and therefore fires no trigger; this
  -- constraint is what makes that guarantee survive any other insert path.
  --
  -- Cascades: a notification deleted with its league or match takes its
  -- delivery job with it, exactly as `push_delivery_attempts` already does.
  notification_id uuid not null unique
    references public.notifications (id) on delete cascade,

  status public.notification_delivery_job_status not null default 'pending',

  -- Claims, not provider sends. Incremented once per claim, so a job that has
  -- been picked up three times has been *started* three times — which is the
  -- number an operator wants when a worker is crash-looping. Provider attempt
  -- counting lives on `push_delivery_attempts` and stays there.
  attempts integer not null default 0,

  claimed_at timestamptz,

  -- An opaque worker token. Never a hostname, a URL or anything with a secret
  -- in it — see the shape constraint.
  claimed_by text,

  -- When this claim stops being believed. See the header: crashed worker,
  -- not provider retry.
  lease_expires_at timestamptz,

  completed_at timestamptz,

  -- A category, never a provider response — the same rule, and the same
  -- regex, that `push_delivery_attempts.last_error_category` follows. Raw
  -- responses carry endpoints and tokens and have no business in a table
  -- somebody will one day `select *` from.
  last_error_category text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint notification_delivery_jobs_attempts_non_negative
    check (attempts >= 0),

  constraint notification_delivery_jobs_error_category_shape
    check (last_error_category is null
           or last_error_category ~ '^[a-z][a-z0-9_]{2,39}$'),

  constraint notification_delivery_jobs_worker_shape
    check (claimed_by is null or claimed_by ~ '^[A-Za-z0-9._:-]{1,64}$'),

  -- Terminal exactly when finished. Stops a `completed` job with no completion
  -- time, and a `pending` one that claims to have finished.
  constraint notification_delivery_jobs_terminal_completed_at
    check ((status in ('completed', 'failed')) = (completed_at is not null)),

  -- A lease exists for precisely as long as the job is being worked on. This is
  -- what makes the reclaim query below correct: nothing outside `processing`
  -- can have an expiring lease, so nothing outside `processing` can be stolen.
  constraint notification_delivery_jobs_lease_only_while_processing
    check ((status = 'processing') = (lease_expires_at is not null))
);


comment on table public.notification_delivery_jobs is
  'Durable queue of push deliveries owed for canonical notifications. Written '
  'by trigger in the notification''s own transaction; drained by the '
  'notification-delivery worker. Service-role only.';

comment on column public.notification_delivery_jobs.attempts is
  'Times this job has been claimed, not times a provider was called.';

comment on column public.notification_delivery_jobs.lease_expires_at is
  'Crashed-worker recovery only. Not a provider retry schedule — see Phase 3C.';


-- ── Indexes the claim actually uses ────────────────────────────────────────
--
-- Both partial, because the interesting rows are a vanishing fraction of the
-- table once the queue is healthy: everything drains to `completed` and stays
-- there. A full index on `status` would grow without bound for no benefit.
create index notification_delivery_jobs_pending_idx
  on public.notification_delivery_jobs (created_at)
  where status = 'pending';

create index notification_delivery_jobs_expired_lease_idx
  on public.notification_delivery_jobs (lease_expires_at)
  where status = 'processing';


-- ── Enqueue ────────────────────────────────────────────────────────────────
--
-- SECURITY DEFINER and owned by `postgres`, which holds BYPASSRLS — the same
-- mechanism that already lets `create_notification` write to the force-RLS
-- `notifications` table. Without it this trigger would be blocked by the very
-- lockdown below, because FORCE ROW LEVEL SECURITY applies to the table owner
-- too.
create function public.enqueue_notification_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notification_delivery_jobs (notification_id)
  values (new.id)
  on conflict (notification_id) do nothing;

  -- AFTER trigger: the return value is discarded, and returning null here
  -- cannot suppress the insert that fired it.
  return null;
end;
$$;


-- WHEN, not an `if` in the body. The condition is evaluated by the executor
-- before the function is entered, so a notification that is not push-eligible
-- costs nothing at all — no call, no plan, no row.
--
-- `push_eligible` is the flag every notification-creating function already
-- writes into `delivery_metadata`. It is deliberately the coarse filter and not
-- the authority: `PUSH_ELIGIBLE_TYPES` in `src/lib/push/payload.ts` remains the
-- one place that decides what may reach a lock screen, and the dispatcher
-- re-checks it. A job for a notification the dispatcher then declines is a
-- cheap no-op; a *missing* job would be a lost notification, so this errs
-- towards enqueueing.
create trigger notifications_enqueue_delivery
  after insert on public.notifications
  for each row
  when (new.delivery_metadata->>'push_eligible' = 'true')
  execute function public.enqueue_notification_delivery();


-- ── Claim ──────────────────────────────────────────────────────────────────
--
-- `for update skip locked` over a bounded window, following exactly the pattern
-- `generate_due_reminders` established. Two workers running at the same instant
-- do not block each other and do not both get the same row: the second skips
-- what the first has locked and takes the next rows instead.
create function public.claim_notification_delivery_jobs(
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
  -- Clamped rather than trusted. A caller asking for a million rows gets 100,
  -- which is what stops one pass of a worker from trying to hold a lock on the
  -- entire queue.
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 120), 10), 900);
begin
  -- Worker-only, the same check and the same reasoning as
  -- `generate_due_reminders`: `auth.role()` reads the verified JWT's role
  -- claim, so a user session presents `authenticated`, the worker's key
  -- presents `service_role`, and a direct server-side connection presents no
  -- JWT at all. Deliberately duplicated with the grant — the grant is the
  -- control, this is what makes a mistake in the grant survivable.
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
    where j.status = 'pending'
       -- Reclaim. A worker that died mid-batch left its jobs here; the lease
       -- is how the queue notices. Nothing terminal is ever selected, so a
       -- completed delivery cannot be resurrected by this branch.
       or (j.status = 'processing' and j.lease_expires_at < now())
    order by j.created_at
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


-- ── Finish ─────────────────────────────────────────────────────────────────
--
-- Only ever moves a job *out* of `processing`. A job whose lease expired and
-- was reclaimed by a second worker is no longer `processing` under the first
-- worker's claim in any meaningful sense — but more importantly, a job that has
-- already reached a terminal state cannot be reopened, re-failed, or have its
-- completion time rewritten by a straggler.
--
-- Returns whether it actually moved, so a worker can log the straggler case
-- rather than silently believing it finished something.
create function public.complete_notification_delivery_job(
  p_job_id uuid,
  p_status public.notification_delivery_job_status,
  p_error_category text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if coalesce(auth.role(), 'service_role') <> 'service_role' then
    raise exception 'NOT_AUTHORIZED: notification delivery is a server-side operation'
      using errcode = '42501';
  end if;

  -- `pending` and `processing` are not completions. Accepting them would let a
  -- worker push a job back into the queue, which is a retry policy, and this
  -- phase does not have one.
  if p_status not in ('completed', 'failed') then
    raise exception 'INVALID_STATUS: a job may only be completed or failed'
      using errcode = '22023';
  end if;

  update public.notification_delivery_jobs j
     set status = p_status,
         completed_at = now(),
         lease_expires_at = null,
         last_error_category = p_error_category,
         updated_at = now()
   where j.id = p_job_id
     and j.status = 'processing';

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;


-- ── Nobody but the worker ──────────────────────────────────────────────────
--
-- RLS enabled AND forced, with **no policies at all**. This is not an oversight
-- to be filled in later: there is no member-facing view of operational queue
-- state, and there should not be one. A player can already see their own
-- notifications and their own delivery attempts; how the machinery got there is
-- not theirs to read, and it is certainly not theirs to write.
--
-- With `authenticated` holding neither BYPASSRLS nor a grant nor a policy, the
-- table is closed to it three times over.
alter table public.notification_delivery_jobs enable row level security;
alter table public.notification_delivery_jobs force row level security;

revoke all on public.notification_delivery_jobs from public;
revoke all on public.notification_delivery_jobs from anon, authenticated;
grant select, insert, update, delete on public.notification_delivery_jobs to service_role;

-- Recreated functions come back EXECUTE-able by PUBLIC, which is the hole
-- 20260805030900 closed for everything that existed then and which
-- `tests/db/schema.test.ts` asserts against. These are new, so they get the
-- same treatment on the way in.
revoke execute on function public.enqueue_notification_delivery() from public;
revoke execute on function public.claim_notification_delivery_jobs(text, integer, integer) from public;
revoke execute on function public.complete_notification_delivery_job(uuid, public.notification_delivery_job_status, text) from public;

grant execute on function public.claim_notification_delivery_jobs(text, integer, integer) to service_role;
grant execute on function public.complete_notification_delivery_job(uuid, public.notification_delivery_job_status, text) to service_role;

-- `enqueue_notification_delivery` is granted to nobody. A trigger function's
-- EXECUTE privilege is checked when the trigger is created, not each time it
-- fires, so the trigger keeps working while the function stays uncallable by
-- hand.


-- ── No backfill, deliberately ──────────────────────────────────────────────
--
-- Every push-eligible notification that exists when this migration runs has
-- already been through the inline dispatcher. Enqueueing them would hand the
-- new worker a backlog reaching back to the first league, and the first thing
-- it would do on its first run is light up every phone in the product with
-- alerts about matches that were played weeks ago.
--
-- `push_delivery_attempts` would suppress most of it — but "most" is not a
-- number worth betting somebody's Saturday morning on, and the recovery from
-- being wrong is that thousands of people have already been woken up. The
-- queue starts empty and fills with what happens next.

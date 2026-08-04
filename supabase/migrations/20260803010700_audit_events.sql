-- Matchday — Phase 1
-- Audit-event foundation.
--
-- 02 §19 requires an audit event for every administrator mutation, and PRD §13
-- makes "every administrator mutation has an audit event" a success metric.
-- Phase 1 delivers the store, the write path and the read policy; the mutations
-- that populate it arrive from Phase 2 onward.
--
-- `league_id` is NOT NULL: every audit event is tenant-owned, which keeps the
-- invariant in PRD §12 ("every tenant-owned row includes or derives a league
-- identifier") checkable rather than aspirational.

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete cascade,

  -- NULL actor means a system/scheduled action, not an anonymous user.
  actor_user_id uuid references public.profiles (id) on delete set null,

  entity_type text not null,
  entity_id uuid,
  action text not null,

  before_data jsonb,
  after_data jsonb,
  reason text,

  created_at timestamptz not null default now(),

  constraint audit_events_entity_type_format
    check (entity_type ~ '^[a-z][a-z0-9_]{2,39}$'),
  constraint audit_events_action_format
    check (action ~ '^[a-z][a-z0-9_.]{2,59}$'),
  constraint audit_events_before_is_object
    check (before_data is null or jsonb_typeof(before_data) = 'object'),
  constraint audit_events_after_is_object
    check (after_data is null or jsonb_typeof(after_data) = 'object'),
  constraint audit_events_reason_length
    check (reason is null or char_length(btrim(reason)) between 1 and 1000)
);

-- Administrator audit log, newest first.
create index audit_events_league_created_idx
  on public.audit_events (league_id, created_at desc);

-- "What happened to this membership/league?"
create index audit_events_entity_idx
  on public.audit_events (entity_type, entity_id);

-- "What did this administrator do?"
create index audit_events_actor_created_idx
  on public.audit_events (actor_user_id, created_at desc);

-- Audit events are append-only. Enforced by a trigger, so the rule survives
-- even a service-role connection that bypasses RLS. DELETE is intentionally
-- still permitted so that deleting a league can cascade.
create or replace function public.audit_events_block_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'AUDIT_EVENT_IMMUTABLE: audit events cannot be modified'
    using errcode = '42501';
end;
$$;

create trigger audit_events_immutable
  before update on public.audit_events
  for each row execute function public.audit_events_block_update();

comment on table public.audit_events is
  'Append-only, league-scoped audit trail. Written through '
  'public.record_audit_event(), which derives the actor from the session and '
  'requires active league_admin. Readable only by that league''s administrator.';

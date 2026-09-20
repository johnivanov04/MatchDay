-- MatchDay — Guideline 1.2: the operational path that stops a report sitting unseen.
--
-- Apple's requirement is a mechanism to report offensive content AND timely
-- responses to it. A table nobody reads satisfies the first half and fails the
-- second, so a report has to reach a human by itself rather than waiting to be
-- noticed.
--
-- The send happens on the existing cron, not in the request that files the
-- report. Phase 3B moved every provider call out of user-facing request paths
-- and that is a property worth keeping: a member pressing "Report" should not
-- wait on Resend, and Resend being down should not stop a report being recorded.

alter table public.content_reports
  add column escalated_at timestamptz;

comment on column public.content_reports.escalated_at is
  'When this report was put in front of a human. Null until the escalation cron sends it. The gap between created_at and this is the number worth being able to measure.';

-- The claim index: open reports nobody has been told about yet.
create index content_reports_unescalated on public.content_reports (created_at)
  where escalated_at is null;


-- ── WHAT THE OPERATOR IS TOLD ──────────────────────────────────────────────
--
-- Deliberately thin. The escalation carries the report id, what kind of thing
-- was reported, the stated reason and when — enough to open the record and act,
-- and nothing that would put a member's identity or the reported text into an
-- inbox and a mail provider's logs. Whoever handles the report reads the detail
-- from the database, authenticated, not from an email.
create or replace function public.claim_unescalated_reports(p_limit integer default 50)
returns table (
  report_id uuid,
  target_type public.report_target_type,
  reason public.report_reason,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), 'service_role') <> 'service_role' then
    raise exception 'NOT_AUTHORIZED: report escalation is a server-side operation'
      using errcode = '42501';
  end if;

  return query
  with claimed as (
    update public.content_reports r
       set escalated_at = now(),
           updated_at = now()
     where r.id in (
             select r2.id
               from public.content_reports r2
              where r2.escalated_at is null
              order by r2.created_at
              limit greatest(1, least(coalesce(p_limit, 50), 200))
              for update skip locked
           )
    returning r.id, r.target_type, r.reason, r.created_at
  )
  select c.id, c.target_type, c.reason, c.created_at from claimed c
  order by c.created_at;
end;
$$;

revoke execute on function public.claim_unescalated_reports(integer) from public, anon, authenticated;
grant execute on function public.claim_unescalated_reports(integer) to service_role;


-- ── OPERATOR REVIEW ────────────────────────────────────────────────────────
--
-- The smallest secure way to resolve a report: service-role only, no console,
-- no new admin surface. A report is closed by the person who handled it,
-- through the same service-role seam the delivery worker already uses.
create or replace function public.resolve_content_report(
  p_report_id uuid,
  p_status public.report_status,
  p_resolution_note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), 'service_role') <> 'service_role' then
    raise exception 'NOT_AUTHORIZED: resolving a report is a server-side operation'
      using errcode = '42501';
  end if;

  if p_status not in ('reviewing', 'actioned', 'dismissed') then
    raise exception 'VALIDATION_FAILED: not a resolution status' using errcode = '23514';
  end if;

  update public.content_reports
     set status = p_status,
         resolution_note = coalesce(nullif(btrim(coalesce(p_resolution_note, '')), ''), resolution_note),
         resolved_at = case when p_status in ('actioned', 'dismissed') then now() else null end,
         updated_at = now()
   where id = p_report_id;

  if not found then
    raise exception 'NOT_AUTHORIZED: no such report' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.resolve_content_report(uuid, public.report_status, text)
  from public, anon, authenticated;
grant execute on function public.resolve_content_report(uuid, public.report_status, text)
  to service_role;

-- No backfill. No report exists yet, nothing is escalated, nothing is sent.

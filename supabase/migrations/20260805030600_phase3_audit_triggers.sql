-- Matchday — Phase 3
-- Audit coverage for guideline, template and match changes.
--
-- Same reasoning as the Phase 2 triggers: administrators hold direct UPDATE
-- policies on these tables, so a change can arrive straight from PostgREST
-- without passing through any application code. A trigger sits below every
-- path.
--
-- Where a SECURITY DEFINER function already writes a precise event —
-- `match.published`, `guideline_version.archived` — the trigger stands down
-- rather than logging the same fact twice. It recognises those cases by the
-- columns only those functions touch, so no cross-cutting flag is needed and
-- there is no way for a caller to suppress an audit event by setting one.
--
-- As in Phase 2, events are written only when `auth.uid()` is present: seeding
-- and service-role maintenance are not administrator actions.

-- ── guideline_versions ─────────────────────────────────────────────────────
create or replace function public.guideline_versions_audit_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_before jsonb;
  v_after jsonb;
begin
  if v_actor is null then
    return null;
  end if;

  if tg_op = 'INSERT' then
    perform public.log_audit_event(
      new.league_id, v_actor, 'guideline_version', new.id, 'guideline_version.created',
      null,
      jsonb_build_object('version_label', new.version_label, 'title', new.title,
                         'requires_acceptance', new.requires_acceptance),
      null);
    return null;
  end if;

  -- publish_guideline_version() and archive_guideline_version() own these two
  -- columns and log their own, more meaningful, events.
  if new.published_at is distinct from old.published_at
     or new.archived_at is distinct from old.archived_at
  then
    return null;
  end if;

  v_before := public.jsonb_changed_keys(
    to_jsonb(old) - 'updated_at' - 'content_checksum',
    to_jsonb(new) - 'updated_at' - 'content_checksum', 'before');
  v_after := public.jsonb_changed_keys(
    to_jsonb(old) - 'updated_at' - 'content_checksum',
    to_jsonb(new) - 'updated_at' - 'content_checksum', 'after');

  if v_after = '{}'::jsonb then
    return null;
  end if;

  perform public.log_audit_event(
    new.league_id, v_actor, 'guideline_version', new.id, 'guideline_version.updated',
    v_before, v_after, null);

  return null;
end;
$$;

create trigger guideline_versions_audit_change
  after insert or update on public.guideline_versions
  for each row execute function public.guideline_versions_audit_change();


-- ── match_templates ────────────────────────────────────────────────────────
-- No function manages templates, so every change is logged here.
create or replace function public.match_templates_audit_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_before jsonb;
  v_after jsonb;
begin
  if v_actor is null then
    return null;
  end if;

  if tg_op = 'INSERT' then
    perform public.log_audit_event(
      new.league_id, v_actor, 'match_template', new.id, 'match_template.created',
      null,
      jsonb_build_object('name', new.name, 'capacity', new.capacity,
                         'day_of_week', new.day_of_week),
      null);
    return null;
  end if;

  v_before := public.jsonb_changed_keys(
    to_jsonb(old) - 'updated_at', to_jsonb(new) - 'updated_at', 'before');
  v_after := public.jsonb_changed_keys(
    to_jsonb(old) - 'updated_at', to_jsonb(new) - 'updated_at', 'after');

  if v_after = '{}'::jsonb then
    return null;
  end if;

  perform public.log_audit_event(
    new.league_id, v_actor, 'match_template', new.id, 'match_template.updated',
    v_before, v_after, null);

  return null;
end;
$$;

create trigger match_templates_audit_change
  after insert or update on public.match_templates
  for each row execute function public.match_templates_audit_change();


-- ── matches ────────────────────────────────────────────────────────────────
-- create_match(), publish_match(), cancel_match() and update_published_match()
-- log their own events. What is left for the trigger is the case they do not
-- cover: an administrator editing a *draft* through the ordinary UPDATE policy.
create or replace function public.matches_audit_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_before jsonb;
  v_after jsonb;
begin
  if v_actor is null then
    return null;
  end if;

  -- Columns owned by the lifecycle functions, each of which logs a precise
  -- event of its own.
  if new.status is distinct from old.status
     or new.published_at is distinct from old.published_at
     or new.canceled_at is distinct from old.canceled_at
     or new.revision is distinct from old.revision
  then
    return null;
  end if;

  v_before := public.jsonb_changed_keys(
    to_jsonb(old) - 'updated_at', to_jsonb(new) - 'updated_at', 'before');
  v_after := public.jsonb_changed_keys(
    to_jsonb(old) - 'updated_at', to_jsonb(new) - 'updated_at', 'after');

  if v_after = '{}'::jsonb then
    return null;
  end if;

  perform public.log_audit_event(
    new.league_id, v_actor, 'match', new.id,
    case when old.status = 'draft' then 'match.draft_updated' else 'match.updated' end,
    v_before, v_after, null);

  return null;
end;
$$;

create trigger matches_audit_change
  after update on public.matches
  for each row execute function public.matches_audit_change();


-- ── match_admin_notes ──────────────────────────────────────────────────────
-- The note text itself is deliberately NOT copied into the audit event: notes
-- are the one place an administrator writes free-form commentary about a
-- person, and audit rows are readable by every future administrator of the
-- league. Recording that a note changed is enough.
create or replace function public.match_admin_notes_audit_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    return null;
  end if;

  perform public.log_audit_event(
    new.league_id, v_actor, 'match', new.match_id,
    case when tg_op = 'INSERT' then 'match.admin_note_added'
         else 'match.admin_note_updated' end,
    null, jsonb_build_object('has_notes', true), null);

  return null;
end;
$$;

create trigger match_admin_notes_audit_change
  after insert or update on public.match_admin_notes
  for each row execute function public.match_admin_notes_audit_change();

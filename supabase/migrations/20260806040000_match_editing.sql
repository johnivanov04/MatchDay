-- Matchday — Phase 3B
-- Editing a match after it has been created.
--
-- Phase 3 shipped creation, publication and cancellation but no edit path that
-- an interface could reach: `update_published_match()` existed with no caller,
-- and drafts could only be changed by a direct `UPDATE` through the
-- `matches_update_draft_admin` policy. That policy is correct as far as it
-- goes, but it is not usable from the application, because resolving a local
-- date and wall-clock time into an instant would have to happen in TypeScript —
-- a second daylight-saving implementation, drifting from the one in
-- `create_match()`.
--
-- So drafts get a function of their own, built the same way, and published
-- matches keep the deliberate audited path they already had.


-- ── Editing a draft ────────────────────────────────────────────────────────
--
-- Deliberately close to create_match(): same parameters, same `AT TIME ZONE`
-- resolution, same recomputation of every deadline from the new kickoff. What
-- it does NOT do is notify anybody. A draft has never been visible to a member,
-- so there is no expectation to correct and nothing to announce.
--
-- The audit event comes from the existing `matches_audit_change` trigger, which
-- records `match.draft_updated` for any change that does not touch the
-- lifecycle columns. Writing one here as well would double-log it.
create or replace function public.update_draft_match(
  p_match_id uuid,
  p_title text,
  p_match_date date,
  p_arrival_time time,
  p_kickoff_time time,
  p_end_time time,
  p_location_name text,
  p_capacity integer,
  p_min_players integer,
  p_selection_mode public.selection_mode,
  p_waitlist_mode public.waitlist_mode,
  p_team_count integer default 2,
  p_location_map_url text default null,
  p_priority_window interval default null,
  p_signup_closes_before interval default interval '2 hours',
  p_cancellation_cutoff_before interval default interval '1 day',
  p_roster_publish_before interval default null,
  p_public_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_timezone text;
  v_arrival timestamptz;
  v_kickoff timestamptz;
  v_end timestamptz;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  select * into v_match from public.matches m where m.id = p_match_id;

  -- A match in another tenant is reported exactly as one that does not exist.
  if not found or not public.is_league_admin(v_match.league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  -- Published and canceled matches have their own paths — or none at all.
  if v_match.status <> 'draft' then
    raise exception 'MATCH_NOT_DRAFT: only a draft match can be edited this way'
      using errcode = 'P0001';
  end if;

  -- The league's zone, taken from the row rather than from the caller. A match
  -- cannot be moved between timezones by editing it.
  v_timezone := v_match.timezone;

  v_arrival := (p_match_date + p_arrival_time) at time zone v_timezone;
  v_kickoff := (p_match_date + p_kickoff_time) at time zone v_timezone;
  v_end := (p_match_date + p_end_time) at time zone v_timezone;

  update public.matches
     set title = btrim(p_title),
         match_date = p_match_date,
         arrival_at = v_arrival,
         kickoff_at = v_kickoff,
         end_at = v_end,
         location_name = btrim(p_location_name),
         location_map_url = nullif(btrim(coalesce(p_location_map_url, '')), ''),
         capacity = p_capacity,
         min_players = p_min_players,
         selection_mode = p_selection_mode,
         waitlist_mode = p_waitlist_mode,
         team_count = p_team_count,
         priority_window = p_priority_window,
         -- The window runs from publication, so its end is not knowable yet.
         -- `create_match()` leaves this null for the same reason and
         -- `publish_match()` computes it from the window that is configured at
         -- that moment. Carrying an old value forward would both contradict a
         -- changed window and, if the match is moved earlier, break
         -- `matches_priority_window_before_close`.
         priority_window_ends_at = null,
         -- Deadlines are stored as instants but configured as lead times, so
         -- moving kickoff moves all of them with it.
         signup_closes_at = v_kickoff - p_signup_closes_before,
         cancellation_cutoff_at = v_kickoff - p_cancellation_cutoff_before,
         roster_publish_target_at = case when p_roster_publish_before is null then null
                                         else v_kickoff - p_roster_publish_before end,
         public_notes = nullif(btrim(coalesce(p_public_notes, '')), '')
   where id = p_match_id;

  return p_match_id;
end;
$$;


-- ── Editing a published match, with a staleness check ──────────────────────
--
-- Recreated only to add `p_expected_revision`. Everything else — the
-- authorization, the deadline-lead preservation, the audit event, the
-- notification fanout keyed on the new revision — is byte-identical to
-- 20260805030700.
--
-- WHY: the previous version was last-write-wins. Two administrators with the
-- form open, or one who left a tab open while another edited, would silently
-- overwrite each other, and the losing change would still have produced a
-- `match_changed` notification telling members about a time that no longer
-- applies. Passing the revision the form was rendered from turns that into a
-- refusal.
--
-- The parameter defaults to NULL, meaning "do not check", so every existing
-- caller and test continues to work unchanged. The edit form always supplies it.
--
-- The previous signature is DROPPED rather than left alongside. Adding a
-- defaulted parameter creates an overload, not a replacement, and a
-- thirteen-argument call would then match both candidates — PostgreSQL reports
-- that as "function is not unique" rather than picking one. Dropping first
-- keeps exactly one function, and existing thirteen-argument callers land on it
-- with the new parameter defaulted.
drop function if exists public.update_published_match(
  uuid, text, date, time, time, time, text, integer, integer, integer, text, text, text
);

create or replace function public.update_published_match(
  p_match_id uuid,
  p_title text,
  p_match_date date,
  p_arrival_time time,
  p_kickoff_time time,
  p_end_time time,
  p_location_name text,
  p_capacity integer,
  p_min_players integer,
  p_team_count integer,
  p_location_map_url text default null,
  p_public_notes text default null,
  p_change_note text default null,
  p_expected_revision integer default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_timezone text;
  v_arrival timestamptz;
  v_kickoff timestamptz;
  v_end timestamptz;
  v_signup_lead interval;
  v_cancel_lead interval;
  v_roster_lead interval;
  v_revision integer;
  v_slug text;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  select * into v_match from public.matches m where m.id = p_match_id;

  if not found or not public.is_league_admin(v_match.league_id) then
    raise exception 'NOT_LEAGUE_ADMIN: not the administrator of that league'
      using errcode = '42501';
  end if;

  if v_match.status <> 'open' then
    raise exception 'MATCH_NOT_OPEN: only an open match can be edited this way'
      using errcode = 'P0001';
  end if;

  -- Optimistic concurrency. Checked before anything is written, so a stale
  -- submission changes nothing and notifies nobody.
  if p_expected_revision is not null and p_expected_revision <> v_match.revision then
    raise exception
      'MATCH_REVISION_STALE: this match was changed by somebody else; reload and try again'
      using errcode = 'P0001';
  end if;

  v_timezone := v_match.timezone;

  -- Deadlines were stored as instants, so preserve how far ahead of kickoff
  -- they sat rather than re-deriving them from defaults the administrator may
  -- have overridden.
  v_signup_lead := v_match.kickoff_at - v_match.signup_closes_at;
  v_cancel_lead := v_match.kickoff_at - v_match.cancellation_cutoff_at;
  v_roster_lead := case when v_match.roster_publish_target_at is null then null
                        else v_match.kickoff_at - v_match.roster_publish_target_at end;

  v_arrival := (p_match_date + p_arrival_time) at time zone v_timezone;
  v_kickoff := (p_match_date + p_kickoff_time) at time zone v_timezone;
  v_end := (p_match_date + p_end_time) at time zone v_timezone;

  update public.matches
     set title = btrim(p_title),
         match_date = p_match_date,
         arrival_at = v_arrival,
         kickoff_at = v_kickoff,
         end_at = v_end,
         location_name = btrim(p_location_name),
         location_map_url = nullif(btrim(coalesce(p_location_map_url, '')), ''),
         capacity = p_capacity,
         min_players = p_min_players,
         team_count = p_team_count,
         public_notes = nullif(btrim(coalesce(p_public_notes, '')), ''),
         signup_closes_at = v_kickoff - v_signup_lead,
         cancellation_cutoff_at = v_kickoff - v_cancel_lead,
         roster_publish_target_at = case when v_roster_lead is null then null
                                         else v_kickoff - v_roster_lead end,
         priority_window_ends_at = case
           when v_match.priority_window_ends_at is null then null
           else least(v_match.priority_window_ends_at, v_kickoff - v_signup_lead)
         end,
         revision = v_match.revision + 1
   where id = p_match_id
  returning revision into v_revision;

  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match', p_match_id, 'match.updated',
    jsonb_build_object('title', v_match.title, 'kickoff_at', v_match.kickoff_at,
                       'capacity', v_match.capacity, 'revision', v_match.revision),
    jsonb_build_object('title', btrim(p_title), 'kickoff_at', v_kickoff,
                       'capacity', p_capacity, 'revision', v_revision),
    nullif(btrim(coalesce(p_change_note, '')), '')
  );

  select l.slug into v_slug from public.leagues l where l.id = v_match.league_id;

  -- The revision is part of the key, so this change notifies once while a
  -- retried submission of the same edit does not — and a genuinely new edit
  -- still gets through.
  perform public.notify_league_members(
    v_match.league_id, 'match_changed',
    'Updated: ' || btrim(p_title),
    to_char(v_kickoff at time zone v_timezone, 'Dy DD Mon HH24:MI')
      || ' at ' || btrim(p_location_name),
    '/leagues/' || v_slug || '/matches/' || p_match_id::text,
    'match_changed:' || p_match_id::text || ':' || v_revision::text,
    p_match_id, v_actor,
    jsonb_build_object('push_eligible', true)
  );

  return v_revision;
end;
$$;


-- ── Grants ─────────────────────────────────────────────────────────────────
-- `create or replace` on a function with a changed signature creates a NEW
-- function, which arrives with PostgreSQL's built-in EXECUTE-to-PUBLIC default.
-- Phase 3 learned that the hard way (see 20260805030900), so both are revoked
-- explicitly and granted by name.

revoke execute on function public.update_draft_match(
  uuid, text, date, time, time, time, text, integer, integer,
  public.selection_mode, public.waitlist_mode, integer, text,
  interval, interval, interval, interval, text
) from public;

grant execute on function public.update_draft_match(
  uuid, text, date, time, time, time, text, integer, integer,
  public.selection_mode, public.waitlist_mode, integer, text,
  interval, interval, interval, interval, text
) to authenticated, service_role;

revoke execute on function public.update_published_match(
  uuid, text, date, time, time, time, text, integer, integer, integer,
  text, text, text, integer
) from public;

grant execute on function public.update_published_match(
  uuid, text, date, time, time, time, text, integer, integer, integer,
  text, text, text, integer
) to authenticated, service_role;

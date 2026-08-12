-- Matchday — Phase 5J/5K
-- Reminder generation, and the rest of the notification centre.


-- ── Materialising a match's reminders ──────────────────────────────────────
--
-- Called when a match is published. Resolves each configured offset into a
-- concrete instant from the match's own stored `kickoff_at`, which is already
-- an absolute timestamp fixed at creation — so nothing here re-derives a time
-- from a recurrence rule or a timezone, and a reminder cannot drift across a
-- daylight-saving transition relative to the match it belongs to.
--
-- Offsets that would already be in the past are skipped: a match published
-- three hours before kickoff should not immediately fire its "tomorrow"
-- reminder.
create or replace function public.materialize_match_reminders(p_match_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match public.matches;
  v_offset interval;
  v_created integer := 0;
begin
  select * into v_match from public.matches m where m.id = p_match_id;
  if not found then
    return 0;
  end if;

  foreach v_offset in array v_match.reminder_offsets loop
    if v_match.kickoff_at - v_offset > now() then
      insert into public.match_reminders (league_id, match_id, offset_before, due_at)
      values (v_match.league_id, p_match_id, v_offset, v_match.kickoff_at - v_offset)
      -- Re-publishing, or publishing a match that was reopened, must not
      -- create a second copy of the same reminder.
      on conflict (match_id, offset_before) do nothing;

      if found then
        v_created := v_created + 1;
      end if;
    end if;
  end loop;

  return v_created;
end;
$$;


-- ── The due-reminder generator ─────────────────────────────────────────────
--
-- The whole scheduling mechanism, and deliberately a *pull*: something outside
-- the database asks "what is due?" on a cadence, rather than the application
-- holding timers. A `setTimeout` would vanish on the next deploy, and a
-- process-local timer would fire once per running instance.
--
-- Idempotency has two independent layers, because this will be invoked by
-- whatever production scheduler is configured and those retry:
--
--   1. `for update skip locked` on pending rows. A second concurrent run does
--      not wait for the first — it skips the claimed rows entirely and finds
--      nothing to do, so two workers never process one reminder.
--   2. the notification idempotency key, `reminder:<reminder id>:<recipient>`,
--      which makes even a duplicated claim produce no second inbox row.
--
-- Reminders go to **confirmed players only**. They are the people who have
-- undertaken to turn up, and a reminder to somebody who was not selected would
-- be noise about a match they are not in.
-- Returns the reminders it claimed, so the caller can push exactly those
-- batches by idempotency-key prefix rather than re-scanning every reminder
-- notification ever created.
create or replace function public.generate_due_reminders(p_limit integer default 100)
returns table (reminder_id uuid, notified integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reminder record;
  v_match public.matches;
  v_slug text;
  v_recipient record;
  v_sent integer;
begin
  -- Worker-only, following the pattern 20260805030900 established for
  -- `record_push_delivery_result`: `auth.role()` reads the verified JWT's role
  -- claim, so a user session presents `authenticated`, the worker's
  -- service-role key presents `service_role`, and a direct server-side
  -- connection presents no JWT at all. Only the last two may generate.
  --
  -- Deliberate duplication of the grant. The grant is the control; this is what
  -- makes a mistake in the grant survivable.
  if coalesce(auth.role(), 'service_role') <> 'service_role' then
    raise exception 'NOT_AUTHORIZED: reminder generation is a server-side operation'
      using errcode = '42501';
  end if;

  for v_reminder in
    select r.id, r.match_id, r.league_id
    from public.match_reminders r
    join public.matches m on m.id = r.match_id
    where r.generated_at is null
      and r.due_at <= now()
      -- A canceled match sends no reminders. Its members were told it was
      -- canceled; reminding them to turn up would be worse than silence.
      and m.status in ('open', 'roster_finalized')
      -- Nor does one whose kickoff has already passed, which is what a
      -- scheduler that was down for a day would otherwise deliver.
      and m.kickoff_at > now()
    order by r.due_at
    limit p_limit
    for update of r skip locked
  loop
    select * into v_match from public.matches m where m.id = v_reminder.match_id;
    select l.slug into v_slug from public.leagues l where l.id = v_reminder.league_id;

    v_sent := 0;

    for v_recipient in
      select m.user_id, s.membership_id
      from public.match_signups s
      join public.league_memberships m on m.id = s.membership_id
      where s.match_id = v_reminder.match_id
        and public.signup_consumes_capacity(s.status)
        -- A removed or suspended member is not entitled to member-only
        -- content, and a reminder is a pointer to member-only content.
        and m.status = 'active'
    loop
      if public.create_notification(
           v_recipient.user_id, v_reminder.league_id, 'reminder',
           v_match.title,
           to_char(v_match.kickoff_at at time zone v_match.timezone, 'Dy DD Mon HH24:MI')
             || ' at ' || v_match.location_name,
           '/leagues/' || v_slug || '/matches/' || v_reminder.match_id::text,
           'reminder:' || v_reminder.id::text || ':' || v_recipient.membership_id::text,
           v_reminder.match_id,
           jsonb_build_object('push_eligible', true)
         ) is not null
      then
        v_sent := v_sent + 1;
      end if;
    end loop;

    update public.match_reminders
       set generated_at = now(), notified_count = v_sent
     where id = v_reminder.id;

    reminder_id := v_reminder.id;
    notified := v_sent;
    return next;
  end loop;

  return;
end;
$$;


-- ── Publishing a match now also schedules its reminders ────────────────────
--
-- Recreated from 20260805030700 with one added line. Everything else — the
-- authorization, the idempotent-by-state check, the member fanout — is
-- unchanged.
create or replace function public.publish_match(p_match_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_match public.matches;
  v_published_at timestamptz := now();
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

  -- Idempotent by state: this is the event that creates one notification per
  -- member, and a resubmitted form must not produce a second round.
  if v_match.status = 'open' then
    return v_match.id;
  end if;

  if v_match.status <> 'draft' then
    raise exception 'MATCH_NOT_OPEN: only a draft match can be published'
      using errcode = 'P0001';
  end if;

  update public.matches
     set status = 'open',
         published_at = v_published_at,
         priority_window_ends_at = case
           when v_match.priority_window is null then null
           else least(v_published_at + v_match.priority_window, v_match.signup_closes_at)
         end
   where id = p_match_id;

  perform public.log_audit_event(
    v_match.league_id, v_actor, 'match', p_match_id, 'match.published',
    jsonb_build_object('status', v_match.status),
    jsonb_build_object('status', 'open', 'published_at', v_published_at),
    null
  );

  select l.slug into v_slug from public.leagues l where l.id = v_match.league_id;

  perform public.notify_league_members(
    v_match.league_id, 'match_published',
    'New match: ' || v_match.title,
    to_char(v_match.kickoff_at at time zone v_match.timezone, 'Dy DD Mon HH24:MI')
      || ' at ' || v_match.location_name,
    '/leagues/' || v_slug || '/matches/' || p_match_id::text,
    'match_published:' || p_match_id::text,
    p_match_id, v_actor,
    jsonb_build_object('push_eligible', true)
  );

  -- The one Phase 5 addition: resolve the configured offsets into concrete
  -- pending rows now that there is a published match to remind people about.
  perform public.materialize_match_reminders(p_match_id);

  return v_match.id;
end;
$$;


-- ── Notification centre: unread and archive ────────────────────────────────
--
-- Phase 3 shipped `mark_notification_read` and left these two, noting that the
-- schema already carried `archived_at` and a nullable `read_at` so they would
-- be additions rather than a migration. This is that addition.
--
-- Both are scoped by recipient in the WHERE clause, so naming somebody else's
-- notification is a miss — indistinguishable from an identifier that does not
-- exist, and incapable of mutating another user's row.

create or replace function public.mark_notification_unread(p_notification_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  update public.notifications
     set read_at = null
   where id = p_notification_id
     and recipient_user_id = v_actor
  returning id into v_id;

  if v_id is null then
    raise exception 'NOTIFICATION_NOT_FOUND: no such notification'
      using errcode = 'P0001';
  end if;

  return v_id;
end;
$$;

-- Archiving takes the row out of the active inbox and out of the unread count,
-- which is what `getMyNotifications` and `getUnreadNotificationCount` already
-- filter on — this function completes a behaviour the reads already assume.
--
-- `read_at` is deliberately left alone. Archiving is "I am done with this",
-- which is not the same claim as "I read this", and overwriting the timestamp
-- would destroy the only record of whether they ever did.
--
-- Nothing is deleted. `archived_at` is a marker, so the row survives for the
-- audit and history the product expects of every record.
create or replace function public.archive_notification(p_notification_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  update public.notifications
     -- coalesce, so archiving twice keeps the first timestamp and the operation
     -- is idempotent rather than merely repeatable.
     set archived_at = coalesce(archived_at, now())
   where id = p_notification_id
     and recipient_user_id = v_actor
  returning id into v_id;

  if v_id is null then
    raise exception 'NOTIFICATION_NOT_FOUND: no such notification'
      using errcode = 'P0001';
  end if;

  return v_id;
end;
$$;

create or replace function public.unarchive_notification(p_notification_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED: no authenticated session' using errcode = '42501';
  end if;

  update public.notifications
     set archived_at = null
   where id = p_notification_id
     and recipient_user_id = v_actor
  returning id into v_id;

  if v_id is null then
    raise exception 'NOTIFICATION_NOT_FOUND: no such notification'
      using errcode = 'P0001';
  end if;

  return v_id;
end;
$$;


-- ══ RLS and grants ═════════════════════════════════════════════════════════

alter table public.match_reminders enable row level security;
alter table public.match_reminders force row level security;

-- Administrator-only, and read-only. A reminder is league scheduling state: a
-- member sees the notification it produces, not the schedule that produced it.
-- Writes belong to the two functions above.
create policy match_reminders_select_admin
  on public.match_reminders for select to authenticated
  using (public.is_league_admin(league_id));

grant select on public.match_reminders to authenticated;
grant select, insert, update, delete on public.match_reminders to service_role;

revoke execute on function public.materialize_match_reminders(uuid) from public;
revoke execute on function public.generate_due_reminders(integer) from public;
revoke execute on function public.mark_notification_unread(uuid) from public;
revoke execute on function public.archive_notification(uuid) from public;
revoke execute on function public.unarchive_notification(uuid) from public;

-- Reached only from publish_match(), which runs as its owner.
grant execute on function public.materialize_match_reminders(uuid) to service_role;

-- The worker's entry point. Not granted to `authenticated`: it acts for no user
-- and writes notifications addressed to many, which is exactly what a client
-- must never be able to do. The in-function role check is the second layer.
grant execute on function public.generate_due_reminders(integer) to service_role;

grant execute on function public.mark_notification_unread(uuid) to authenticated, service_role;
grant execute on function public.archive_notification(uuid) to authenticated, service_role;
grant execute on function public.unarchive_notification(uuid) to authenticated, service_role;

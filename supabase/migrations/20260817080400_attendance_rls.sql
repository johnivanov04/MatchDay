-- Matchday — Phase 7R
-- Who may read an attendance record.
--
-- THE NOTE IS THE REASON THIS IS NOT A SIMPLE POLICY. 7F requires a player to
-- see their own outcome, and 7C keeps the administrator's note private. RLS
-- filters rows and not columns, so a policy generous enough to show a player
-- their own row would also show them the note attached to it.
--
-- So the table stays administrator-only — the same shape Phase 6 used for team
-- drafts — and the player reads their own outcome through `my_attendance()` and
-- `my_attendance_history()`, which are SECURITY DEFINER projections that simply
-- never select the note column. There is no second way in.

alter table public.attendance_records enable row level security;
alter table public.attendance_records force row level security;

-- Read-only even for the administrator. Every write goes through
-- `record_attendance()`, which takes the match row lock, checks the match has
-- ended, checks the player was in the attendance population, bumps the revision
-- and writes the audit event. A direct UPDATE could do none of that, and a
-- correction that skipped the audit event would defeat the point of 7E.
create policy attendance_records_select_admin
  on public.attendance_records for select to authenticated
  using (public.is_league_admin(league_id));

grant select on public.attendance_records to authenticated;
grant select, insert, update, delete on public.attendance_records to service_role;

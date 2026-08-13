-- Matchday — Phase 7P
-- The attendance notification type.
--
-- Alone in its own migration for the same mechanical reason as Phases 4, 5 and
-- 6: PostgreSQL allows `ALTER TYPE ... ADD VALUE` inside a transaction block,
-- but the new value cannot be *used* until that transaction commits, and every
-- migration runs in a transaction.
--
-- One type, not two. 02 §14 lists a single required event — "Attendance/no-show
-- status recorded" — and the first recording and a later correction are the
-- same fact about the same match arriving twice, unlike a roster or team
-- publication where "changed" genuinely means something different to the
-- reader. The revision in the idempotency key is what distinguishes them.

alter type public.notification_type add value if not exists 'attendance_recorded';

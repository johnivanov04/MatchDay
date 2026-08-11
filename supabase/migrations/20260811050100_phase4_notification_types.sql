-- Matchday — Phase 4M
-- The six Phase 4 notification types.
--
-- Alone in its own migration for a mechanical reason: PostgreSQL allows
-- `ALTER TYPE ... ADD VALUE` inside a transaction block, but the new value
-- cannot be *used* until that transaction commits. Every migration runs in a
-- transaction, so a function referencing 'signup_confirmed' in the same file
-- that added it would fail with "unsafe use of new value of enum type".
--
-- 02 §14 lists all of these under the required notification types. The three it
-- also lists that are absent here — cancellation receipt, late-cancellation
-- administrator alert, and waitlist promotion — all belong to the Phase 5
-- cancellation workflow and are added by the phase that can send them.

alter type public.notification_type add value if not exists 'signup_confirmed';
alter type public.notification_type add value if not exists 'signup_pending';
alter type public.notification_type add value if not exists 'waitlisted';
alter type public.notification_type add value if not exists 'not_selected';
alter type public.notification_type add value if not exists 'roster_published';
alter type public.notification_type add value if not exists 'roster_changed';

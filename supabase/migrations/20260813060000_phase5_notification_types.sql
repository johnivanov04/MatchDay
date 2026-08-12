-- Matchday — Phase 5H
-- The five Phase 5 notification types.
--
-- Alone in its own migration for the same mechanical reason as Phase 4's:
-- PostgreSQL allows `ALTER TYPE ... ADD VALUE` inside a transaction block, but
-- the new value cannot be *used* until that transaction commits, and every
-- migration runs in a transaction.
--
-- These complete 02 §14's list. `roster_changed` is deliberately absent —
-- Phase 4 already added it and a cancellation that changes a published roster
-- reuses it rather than inventing a second name for the same event.

alter type public.notification_type add value if not exists 'cancellation_receipt';
alter type public.notification_type add value if not exists 'late_cancellation';
alter type public.notification_type add value if not exists 'waitlist_promotion';
-- The administrator-controlled counterpart to automatic promotion: a spot has
-- opened and, by configuration, nobody was moved into it.
alter type public.notification_type add value if not exists 'replacement_needed';
alter type public.notification_type add value if not exists 'reminder';

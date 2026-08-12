-- Matchday — Phase 6N
-- The two team notification types.
--
-- Alone in its own migration for the same mechanical reason as Phases 4 and 5:
-- PostgreSQL allows `ALTER TYPE ... ADD VALUE` inside a transaction block, but
-- the new value cannot be *used* until that transaction commits, and every
-- migration runs in a transaction.
--
-- Two types rather than one, matching how `roster_published` and
-- `roster_changed` already split the same distinction: the first publication
-- and a later change are different events to the person receiving them, and a
-- single type would force the reader to infer which from the body text.
--
-- Note `teams_published` also exists as a value of `match_lifecycle_status`.
-- The two are unrelated: that one is a match state this phase deliberately
-- leaves unreachable, this one is a notification type.

alter type public.notification_type add value if not exists 'teams_published';
alter type public.notification_type add value if not exists 'teams_changed';

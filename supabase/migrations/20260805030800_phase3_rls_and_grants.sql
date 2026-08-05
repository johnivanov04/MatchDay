-- Matchday — Phase 3
-- Row Level Security and privileges for everything Phase 3 adds.
--
-- Additive only: no Phase 1 or Phase 2 policy or grant is altered or dropped.
--
-- Both default-privilege rules established earlier are doing real work here.
-- Phase 1 revoked default table privileges from anon and authenticated, so the
-- seven new tables arrive with none. Phase 2 revoked default EXECUTE from
-- PUBLIC, so the new functions arrive unreachable. Everything below is an
-- explicit, named decision to open something.

-- ── Ownership helpers ──────────────────────────────────────────────────────
-- SECURITY DEFINER for the usual reason: a policy that resolves ownership by
-- querying another RLS-protected table would either recurse or silently depend
-- on that table's own policies being wide enough.

create or replace function public.owns_membership(p_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.league_memberships m
    where m.id = p_membership_id and m.user_id = auth.uid()
  );
$$;

create or replace function public.owns_push_subscription(p_subscription_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.push_subscriptions s
    where s.id = p_subscription_id and s.user_id = auth.uid()
  );
$$;


alter table public.guideline_versions      enable row level security;
alter table public.guideline_acceptances   enable row level security;
alter table public.match_templates         enable row level security;
alter table public.matches                 enable row level security;
alter table public.match_admin_notes       enable row level security;
alter table public.notifications           enable row level security;
alter table public.push_subscriptions      enable row level security;
alter table public.push_delivery_attempts  enable row level security;

alter table public.guideline_versions      force row level security;
alter table public.guideline_acceptances   force row level security;
alter table public.match_templates         force row level security;
alter table public.matches                 force row level security;
alter table public.match_admin_notes       force row level security;
alter table public.notifications           force row level security;
alter table public.push_subscriptions      force row level security;
alter table public.push_delivery_attempts  force row level security;


-- ── guideline_versions ─────────────────────────────────────────────────────
-- Administrators see everything including drafts. Active members see anything
-- that was ever published — archived versions included, because a member is
-- entitled to re-read the text they once accepted.

create policy guideline_versions_select_admin
  on public.guideline_versions for select to authenticated
  using (public.is_league_admin(league_id));

create policy guideline_versions_select_member
  on public.guideline_versions for select to authenticated
  using (public.is_active_member(league_id) and published_at is not null);

-- A version is always born a draft. Publishing is a separate, audited step.
create policy guideline_versions_insert_admin
  on public.guideline_versions for insert to authenticated
  with check (public.is_league_admin(league_id) and published_at is null and archived_at is null);

-- Drafts only. Published text is frozen (the guard trigger enforces that too),
-- and publish/archive run through SECURITY DEFINER functions that bypass this
-- policy deliberately.
create policy guideline_versions_update_draft_admin
  on public.guideline_versions for update to authenticated
  using (public.is_league_admin(league_id) and published_at is null)
  with check (public.is_league_admin(league_id) and published_at is null);


-- ── guideline_acceptances ──────────────────────────────────────────────────
-- Your own, or — inside a league you administer — everyone's. No write policy
-- at all: accept_guideline_version() is the only door, and the immutability
-- trigger closes the rest.

create policy guideline_acceptances_select_self
  on public.guideline_acceptances for select to authenticated
  using (public.owns_membership(membership_id));

create policy guideline_acceptances_select_admin
  on public.guideline_acceptances for select to authenticated
  using (public.is_league_admin(league_id));


-- ── match_templates ────────────────────────────────────────────────────────
-- Administrator-only in every direction. A template is league configuration,
-- not member-facing content. No DELETE: retire with `is_active = false`.

create policy match_templates_select_admin
  on public.match_templates for select to authenticated
  using (public.is_league_admin(league_id));

create policy match_templates_insert_admin
  on public.match_templates for insert to authenticated
  with check (public.is_league_admin(league_id));

create policy match_templates_update_admin
  on public.match_templates for update to authenticated
  using (public.is_league_admin(league_id))
  with check (public.is_league_admin(league_id));


-- ── matches ────────────────────────────────────────────────────────────────
-- Members see published matches — open and canceled alike, because a
-- cancellation is information a member needs. Drafts are administrator-only,
-- which is what `published_at is not null` guarantees: the schema constraint
-- `matches_published_unless_draft` makes that column a reliable proxy for "has
-- ever been visible".

create policy matches_select_admin
  on public.matches for select to authenticated
  using (public.is_league_admin(league_id));

create policy matches_select_member
  on public.matches for select to authenticated
  using (public.is_active_member(league_id) and published_at is not null);

create policy matches_insert_admin
  on public.matches for insert to authenticated
  with check (public.is_league_admin(league_id) and status = 'draft');

-- DRAFTS ONLY, and a draft may only be edited into a draft.
--
-- This is what makes "published matches may be edited only through a
-- deliberate audited flow" true rather than merely intended. A direct
-- PostgREST UPDATE of an open match is refused; update_published_match() is
-- the only path, and it bumps the revision, writes the audit event and
-- notifies members.
create policy matches_update_draft_admin
  on public.matches for update to authenticated
  using (public.is_league_admin(league_id) and status = 'draft')
  with check (public.is_league_admin(league_id) and status = 'draft');


-- ── match_admin_notes ──────────────────────────────────────────────────────
create policy match_admin_notes_select_admin
  on public.match_admin_notes for select to authenticated
  using (public.is_league_admin(league_id));

create policy match_admin_notes_insert_admin
  on public.match_admin_notes for insert to authenticated
  with check (public.is_league_admin(league_id));

create policy match_admin_notes_update_admin
  on public.match_admin_notes for update to authenticated
  using (public.is_league_admin(league_id))
  with check (public.is_league_admin(league_id));

create policy match_admin_notes_delete_admin
  on public.match_admin_notes for delete to authenticated
  using (public.is_league_admin(league_id));


-- ── notifications ──────────────────────────────────────────────────────────
-- Strictly the recipient's own, read-only. Even a league administrator cannot
-- read a member's notifications: a notification is addressed to a person, not
-- to a tenant.
--
-- No INSERT policy — a client that could write notifications could forge them
-- for anyone. No UPDATE policy either: mark_notification_read() is the only
-- mutation, so `archived_at` and `idempotency_key` cannot be tampered with
-- while allowing read state to change.

create policy notifications_select_self
  on public.notifications for select to authenticated
  using (recipient_user_id = (select auth.uid()));


-- ── push_subscriptions ─────────────────────────────────────────────────────
-- Own rows only, and even then not the credentials — see the column grant
-- below. Writes go through the three SECURITY DEFINER functions.

create policy push_subscriptions_select_self
  on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));


-- ── push_delivery_attempts ─────────────────────────────────────────────────
-- Readable by the owner of the device it was sent to, so a user can see on
-- their own devices page whether alerts are arriving. Written only by the
-- server-side dispatcher.

create policy push_delivery_attempts_select_self
  on public.push_delivery_attempts for select to authenticated
  using (public.owns_push_subscription(subscription_id));


-- ══ Grants ═════════════════════════════════════════════════════════════════

grant select, insert, update on public.guideline_versions to authenticated;
grant select                 on public.guideline_acceptances to authenticated;
grant select, insert, update on public.match_templates to authenticated;
grant select, insert, update on public.matches to authenticated;
grant select, insert, update, delete on public.match_admin_notes to authenticated;
grant select                 on public.notifications to authenticated;
grant select                 on public.push_delivery_attempts to authenticated;

-- COLUMN-LEVEL, deliberately. `endpoint`, `p256dh` and `auth_secret` together
-- are a bearer credential: anyone holding them can display a notification on
-- that device from any server. They are write-only from the API's point of
-- view — a user creates a subscription and can delete it, but can never read
-- its keys back, so a compromised session cannot exfiltrate the ability to
-- push to that person's phone. `select *` on this table fails for
-- `authenticated`; only the service-role dispatcher sees the credentials.
grant select (
  id, user_id, device_label, enabled, created_at, updated_at,
  last_seen_at, last_success_at, consecutive_failures, disabled_reason
) on public.push_subscriptions to authenticated;

-- ── Function EXECUTE, by name ──────────────────────────────────────────────

grant execute on function public.current_required_guideline_version(uuid)
  to authenticated, service_role;
grant execute on function public.has_accepted_required_guidelines(uuid)
  to authenticated, service_role;
grant execute on function public.accept_guideline_version(uuid)
  to authenticated, service_role;
grant execute on function public.publish_guideline_version(uuid)
  to authenticated, service_role;
grant execute on function public.archive_guideline_version(uuid)
  to authenticated, service_role;
grant execute on function public.league_guideline_acceptance_status(uuid)
  to authenticated, service_role;

grant execute on function public.create_match(
  uuid, text, date, time, time, time, text, integer, integer,
  public.selection_mode, public.waitlist_mode, integer, uuid, text,
  interval, interval, interval, interval, text, text
) to authenticated, service_role;
grant execute on function public.publish_match(uuid)              to authenticated, service_role;
grant execute on function public.cancel_match(uuid, text)         to authenticated, service_role;
grant execute on function public.update_published_match(
  uuid, text, date, time, time, time, text, integer, integer, integer, text, text, text
) to authenticated, service_role;

grant execute on function public.mark_notification_read(uuid)     to authenticated, service_role;
grant execute on function public.mark_all_notifications_read()    to authenticated, service_role;

grant execute on function public.register_push_subscription(text, text, text, text)
  to authenticated, service_role;
grant execute on function public.set_push_subscription_enabled(uuid, boolean)
  to authenticated, service_role;
grant execute on function public.remove_push_subscription(uuid)   to authenticated, service_role;

grant execute on function public.owns_membership(uuid)            to authenticated, service_role;
grant execute on function public.owns_push_subscription(uuid)     to authenticated, service_role;

-- Worker-side only. The dispatcher runs server-side as the service role; no
-- user session has any business recording a delivery result.
grant execute on function public.record_push_delivery_result(
  uuid, uuid, public.push_delivery_status, text
) to service_role;

-- ── Deliberately NOT granted to any client role ────────────────────────────
-- public.create_notification(...)     — writes rows addressed to other users.
-- public.notify_league_members(...)   — fans out to a whole league.
-- every trigger function              — fires as the table owner.
--
-- These are reachable only by the SECURITY DEFINER domain functions above,
-- which execute as the owner. Granting either to `authenticated` would let any
-- signed-in user forge notifications for anybody, in any league.
revoke all on function public.create_notification(
  uuid, uuid, public.notification_type, text, text, text, text, uuid, jsonb
) from public, anon, authenticated;

revoke all on function public.notify_league_members(
  uuid, public.notification_type, text, text, text, text, uuid, uuid, jsonb
) from public, anon, authenticated;

-- ── service_role ───────────────────────────────────────────────────────────
grant select, insert, update, delete on public.guideline_versions     to service_role;
grant select, insert, update, delete on public.guideline_acceptances  to service_role;
grant select, insert, update, delete on public.match_templates        to service_role;
grant select, insert, update, delete on public.matches                to service_role;
grant select, insert, update, delete on public.match_admin_notes      to service_role;
grant select, insert, update, delete on public.notifications          to service_role;
grant select, insert, update, delete on public.push_subscriptions     to service_role;
grant select, insert, update, delete on public.push_delivery_attempts to service_role;

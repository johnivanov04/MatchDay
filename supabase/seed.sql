-- Matchday — local development seed.
--
--  ⚠  DEVELOPMENT AND TEST ONLY. Never run against production.
--
-- Run with:  npm run db:reset          (wraps `supabase db reset`)
-- Also applied verbatim by the database test suite, so this file and the tests
-- cannot drift apart.
--
-- Contents required by the Phase 1 scope:
--   * one private RMVFC-style league with default capacity 22
--   * one searchable 5v5 league with default capacity 10
--   * one player who belongs to both leagues
-- plus enough supporting fixtures to exercise every membership status and to
-- prove cross-league isolation.
--
-- All identifiers are fixed UUIDs so tests can reference them, and all e-mail
-- addresses use the reserved `.test` TLD (RFC 6761) so nothing can ever be
-- delivered to a real inbox.
--
-- The entire seed runs in ONE transaction. That is not tidiness: the deferred
-- constraint trigger `enforce_single_active_league_admin` is evaluated at
-- COMMIT, so a league and its administrator membership must be committed
-- together. Splitting this file into autocommitted statements would fail.

begin;

-- ── Safety guard ───────────────────────────────────────────────────────────
-- Set `matchday.environment` to 'production' on any database that must never
-- accept seed data:  ALTER DATABASE <db> SET matchday.environment = 'production';
do $$
begin
  if coalesce(current_setting('matchday.environment', true), 'local') = 'production' then
    raise exception
      'REFUSING TO SEED: matchday.environment is set to production on this database';
  end if;
end;
$$;

-- ── Idempotency ────────────────────────────────────────────────────────────
-- Remove any previous run of this seed. Cascades clear memberships, notes,
-- audit events, app state and profiles.
delete from public.leagues
 where id in (
   '22222222-2222-4222-8222-000000000001',
   '22222222-2222-4222-8222-000000000002'
 );

delete from auth.users
 where id in (
   '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-000000000002',
   '11111111-1111-4111-8111-000000000003',
   '11111111-1111-4111-8111-000000000004',
   '11111111-1111-4111-8111-000000000005',
   '11111111-1111-4111-8111-000000000006',
   '11111111-1111-4111-8111-000000000007',
   '11111111-1111-4111-8111-000000000008'
 );


-- ── Auth users ─────────────────────────────────────────────────────────────
-- Passwordless: Matchday authenticates with email magic links / one-time codes,
-- so `encrypted_password` stays NULL. `email_confirmed_at` is pre-set so these
-- accounts can sign in immediately in local development.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
select
  '00000000-0000-0000-0000-000000000000',
  seed_user.id,
  'authenticated',
  'authenticated',
  seed_user.email,
  null,
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  false,
  now(),
  now(),
  '', '', '', '', '', '', '', ''
from (
  values
    ('11111111-1111-4111-8111-000000000001'::uuid, 'admin.rmvfc@matchday.test'),
    ('11111111-1111-4111-8111-000000000002'::uuid, 'admin.fives@matchday.test'),
    ('11111111-1111-4111-8111-000000000003'::uuid, 'player.multi@matchday.test'),
    ('11111111-1111-4111-8111-000000000004'::uuid, 'player.rmvfc@matchday.test'),
    ('11111111-1111-4111-8111-000000000005'::uuid, 'player.pending@matchday.test'),
    ('11111111-1111-4111-8111-000000000006'::uuid, 'player.suspended@matchday.test'),
    ('11111111-1111-4111-8111-000000000007'::uuid, 'player.removed@matchday.test'),
    ('11111111-1111-4111-8111-000000000008'::uuid, 'outsider@matchday.test')
) as seed_user (id, email);

-- GoTrue resolves an email sign-in through auth.identities.
insert into auth.identities (
  id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(),
  u.id,
  'email',
  u.id::text,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  null,
  now(),
  now()
from auth.users u
where u.id in (
  '11111111-1111-4111-8111-000000000001',
  '11111111-1111-4111-8111-000000000002',
  '11111111-1111-4111-8111-000000000003',
  '11111111-1111-4111-8111-000000000004',
  '11111111-1111-4111-8111-000000000005',
  '11111111-1111-4111-8111-000000000006',
  '11111111-1111-4111-8111-000000000007',
  '11111111-1111-4111-8111-000000000008'
);


-- ── Global profiles ────────────────────────────────────────────────────────
-- Optional fields are deliberately populated unevenly: some players fill in
-- phone/gender/positions/goalkeeper willingness, others leave them NULL. There
-- is no skill field to populate.
insert into public.profiles (
  id, first_name, last_name, email_normalized,
  phone, gender, preferred_positions, goalkeeper_willing, profile_photo_url
) values
  ('11111111-1111-4111-8111-000000000001', 'Rosa',   'Marchetti', 'admin.rmvfc@matchday.test',
   '+1-555-0100', null, '{"Midfield"}', false, null),

  ('11111111-1111-4111-8111-000000000002', 'Dev',    'Anand',     'admin.fives@matchday.test',
   null, null, '{"Defence"}', true, null),

  -- The multi-league player required by the Phase 1 scope.
  ('11111111-1111-4111-8111-000000000003', 'Jules',  'Okonkwo',   'player.multi@matchday.test',
   '+1-555-0103', 'non-binary', '{"Winger","Forward"}', true,
   'https://example.test/photos/jules.jpg'),

  ('11111111-1111-4111-8111-000000000004', 'Priya',  'Raman',     'player.rmvfc@matchday.test',
   null, 'woman', '{"Defence"}', null, null),

  ('11111111-1111-4111-8111-000000000005', 'Tomas',  'Berg',      'player.pending@matchday.test',
   null, null, '{}', null, null),

  ('11111111-1111-4111-8111-000000000006', 'Nadia',  'Haddad',    'player.suspended@matchday.test',
   null, null, '{"Goalkeeper"}', true, null),

  ('11111111-1111-4111-8111-000000000007', 'Owen',   'Petrov',    'player.removed@matchday.test',
   null, null, '{}', null, null),

  ('11111111-1111-4111-8111-000000000008', 'Sam',    'Lindqvist', 'outsider@matchday.test',
   null, null, '{}', null, null);


-- ── Leagues ────────────────────────────────────────────────────────────────
-- Two deliberately different configurations, proving nothing is hard-coded to
-- RMVFC, to 11v11 or to a capacity of 22.
insert into public.leagues (
  id, name, slug, general_area, timezone, sport_label, description, visibility,
  default_capacity, default_min_players, default_selection_mode,
  default_waitlist_mode, default_team_count, default_location, typical_schedule,
  gender_field_enabled, goalkeeper_field_enabled, settings_json, created_by
) values
  (
    '22222222-2222-4222-8222-000000000001',
    'RMV Football Club',
    'rmv-football-club',
    'RMV metro area',
    'America/Los_Angeles',
    'Soccer 11v11',
    'Monday and Wednesday evening 11-a-side pickup matches for club members.',
    'private',
    22,   -- default capacity, per the RMVFC pilot configuration
    14,
    'admin_approval',
    'admin_controlled',
    2,
    'RMV Community Pitch',
    'Mondays and Wednesdays, evenings',
    true,
    true,
    -- Pilot rules live as league configuration, never as global product logic.
    '{"pilot": "rmvfc", "priority_window_hours": 24, "cancellation_cutoff": "12:00 day before"}'::jsonb,
    '11111111-1111-4111-8111-000000000001'
  ),
  (
    '22222222-2222-4222-8222-000000000002',
    'Weeknight 5v5',
    'weeknight-5v5',
    'Downtown',
    'America/Los_Angeles',
    'Soccer 5v5',
    'Small-sided weeknight games. First come, first served.',
    'searchable',
    10,   -- a completely different format and capacity
    8,
    'first_come',
    'automatic',
    2,
    'Eastside Indoor Courts',
    'Thursdays, evenings',
    false,
    true,
    '{}'::jsonb,
    '11111111-1111-4111-8111-000000000002'
  );


-- ── Memberships ────────────────────────────────────────────────────────────
-- Exactly one active league_admin per league. Every membership status is
-- represented so the RLS suite can assert on all four.
insert into public.league_memberships (id, league_id, user_id, role, status, suspended_until)
values
  -- RMV Football Club (private)
  ('33333333-3333-4333-8333-000000000001', '22222222-2222-4222-8222-000000000001',
   '11111111-1111-4111-8111-000000000001', 'league_admin', 'active',   null),
  ('33333333-3333-4333-8333-000000000002', '22222222-2222-4222-8222-000000000001',
   '11111111-1111-4111-8111-000000000003', 'player',       'active',   null),
  ('33333333-3333-4333-8333-000000000003', '22222222-2222-4222-8222-000000000001',
   '11111111-1111-4111-8111-000000000004', 'player',       'active',   null),
  ('33333333-3333-4333-8333-000000000004', '22222222-2222-4222-8222-000000000001',
   '11111111-1111-4111-8111-000000000006', 'player',       'suspended', now() + interval '30 days'),
  ('33333333-3333-4333-8333-000000000005', '22222222-2222-4222-8222-000000000001',
   '11111111-1111-4111-8111-000000000007', 'player',       'removed',  null),

  -- Weeknight 5v5 (searchable)
  ('33333333-3333-4333-8333-000000000011', '22222222-2222-4222-8222-000000000002',
   '11111111-1111-4111-8111-000000000002', 'league_admin', 'active',   null),
  -- The same person as membership …0002 above: one account, two leagues.
  ('33333333-3333-4333-8333-000000000012', '22222222-2222-4222-8222-000000000002',
   '11111111-1111-4111-8111-000000000003', 'player',       'active',   null),
  ('33333333-3333-4333-8333-000000000013', '22222222-2222-4222-8222-000000000002',
   '11111111-1111-4111-8111-000000000005', 'player',       'pending',  null);


-- ── Active-league selection ────────────────────────────────────────────────
-- The multi-league player starts in RMVFC and can switch to Weeknight 5v5.
insert into public.user_app_state (user_id, active_league_id) values
  ('11111111-1111-4111-8111-000000000003', '22222222-2222-4222-8222-000000000001'),
  ('11111111-1111-4111-8111-000000000001', '22222222-2222-4222-8222-000000000001'),
  ('11111111-1111-4111-8111-000000000002', '22222222-2222-4222-8222-000000000002');


-- ── Administrator-only fixtures ────────────────────────────────────────────
-- One note and one audit event per league, so the test suite can prove that
-- neither administrator can read the other league's private records.
insert into public.league_membership_admin_notes (id, league_id, membership_id, note, created_by)
values
  ('44444444-4444-4444-8444-000000000001', '22222222-2222-4222-8222-000000000001',
   '33333333-3333-4333-8333-000000000004',
   'Suspended after repeated late cancellations. Review before the next match.',
   '11111111-1111-4111-8111-000000000001'),
  ('44444444-4444-4444-8444-000000000002', '22222222-2222-4222-8222-000000000002',
   '33333333-3333-4333-8333-000000000013',
   'Join request arrived through the searchable listing; awaiting approval.',
   '11111111-1111-4111-8111-000000000002');

-- ── Phase 2 fixtures ───────────────────────────────────────────────────────
-- One pending join request against the searchable league, so the administrator
-- queue is not empty on a fresh database.
insert into public.league_join_requests (id, league_id, user_id, status, message)
values (
  '66666666-6666-4666-8666-000000000001',
  '22222222-2222-4222-8222-000000000002',
  '11111111-1111-4111-8111-000000000008',
  'pending',
  'Found you through search — I play most Thursdays and would like to join.'
);

-- One live invitation for the private league.
--
-- The token below is public knowledge and exists only so the redemption flow
-- can be exercised locally. Only its SHA-256 digest is stored, exactly as
-- create_league_invite() does it — the raw token is never a column value.
-- Production invitations use 32 bytes from a CSPRNG; see
-- src/lib/leagues/invite-token.ts.
insert into public.league_invites (
  id, league_id, token_hash, label, grants_status, max_uses, expires_at, created_by
) values (
  '77777777-7777-4777-8777-000000000001',
  '22222222-2222-4222-8222-000000000001',
  sha256(convert_to('matchday-local-development-invite-token-0001', 'UTF8')),
  'Local development link',
  'active',
  25,
  now() + interval '14 days',
  '11111111-1111-4111-8111-000000000001'
);

insert into public.audit_events (
  id, league_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason
) values
  ('55555555-5555-4555-8555-000000000001', '22222222-2222-4222-8222-000000000001',
   '11111111-1111-4111-8111-000000000001', 'league_membership',
   '33333333-3333-4333-8333-000000000004', 'membership.status_changed',
   '{"status": "active"}'::jsonb, '{"status": "suspended"}'::jsonb,
   'Repeated late cancellations'),
  ('55555555-5555-4555-8555-000000000002', '22222222-2222-4222-8222-000000000002',
   '11111111-1111-4111-8111-000000000002', 'league',
   '22222222-2222-4222-8222-000000000002', 'league.visibility_changed',
   '{"visibility": "private"}'::jsonb, '{"visibility": "searchable"}'::jsonb,
   'Opening the league to new players');


-- ── Phase 3A fixtures — guidelines ─────────────────────────────────────────
--
-- DEVELOPMENT-ONLY SAMPLE TEXT. This repository does not contain the RMV
-- Football Club "Guidelines for Play" document that PRD §1 cites as source
-- material, and inventing club rules that read as authentic would be worse
-- than useless — someone would eventually ship them. The bodies below are
-- obviously-placeholder prose whose only job is to exercise the acceptance
-- flow. Replace them with the real document before the pilot.
--
-- RMVFC's version requires acceptance, so the seeded members start ineligible
-- for signup and the Phase 4 predicate has something real to test against.
-- Weeknight 5v5's is informational, so the two branches of
-- publish_guideline_version() are both represented.
insert into public.guideline_versions (
  id, league_id, version_label, title, body, effective_at,
  requires_acceptance, published_at, created_by
) values
  (
    '88888888-8888-4888-8888-000000000001',
    '22222222-2222-4222-8222-000000000001',
    '2026-development',
    'RMV Football Club — Guidelines for Play (development sample)',
    E'DEVELOPMENT SAMPLE TEXT — NOT THE CLUB''S ACTUAL GUIDELINES.\n\n'
      'Arrive by the stated arrival time so teams can be organised before '
      'kickoff.\n\n'
      'Cancel through the app as soon as you know you cannot play, so that '
      'somebody on the waitlist can take the spot.\n\n'
      'Treat opponents, teammates and neighbours with respect. The club is a '
      'guest at this pitch.\n\n'
      'Replace this text with the real Guidelines for Play before the pilot.',
    now() - interval '30 days',
    true,
    now() - interval '30 days',
    '11111111-1111-4111-8111-000000000001'
  ),
  (
    '88888888-8888-4888-8888-000000000002',
    '22222222-2222-4222-8222-000000000002',
    '2026-house-rules',
    'Weeknight 5v5 — House rules (development sample)',
    E'DEVELOPMENT SAMPLE TEXT — NOT ACTUAL LEAGUE RULES.\n\n'
      'Small-sided, self-refereed, no slide tackles.\n\n'
      'Rotate goalkeeper every fifteen minutes unless somebody volunteers to '
      'stay in.\n\n'
      'Informational only: this version does not require acceptance.',
    now() - interval '10 days',
    false,
    now() - interval '10 days',
    '11111111-1111-4111-8111-000000000002'
  );

-- One member has already accepted, one has not, so the eligibility predicate
-- has both answers available on a fresh database.
insert into public.guideline_acceptances (league_id, guideline_version_id, membership_id)
values (
  '22222222-2222-4222-8222-000000000001',
  '88888888-8888-4888-8888-000000000001',
  '33333333-3333-4333-8333-000000000002'   -- the multi-league player
);


-- ── Phase 3B fixtures — templates and matches ──────────────────────────────
-- PRD §7 describes the RMVFC pilot as Monday and Wednesday evening matches at
-- 11v11 with a capacity of 22. Both leagues use America/Los_Angeles, matching
-- the timezone currently stored on the seeded leagues.
insert into public.match_templates (
  id, league_id, name, day_of_week, arrival_time, kickoff_time, end_time,
  location_name, capacity, min_players, selection_mode, waitlist_mode,
  team_count, priority_window, signup_closes_before, cancellation_cutoff_before,
  roster_publish_before, reminder_offsets, created_by
) values
  (
    '99999999-9999-4999-8999-000000000001',
    '22222222-2222-4222-8222-000000000001',
    'Monday evening 11v11', 1,
    '18:30', '19:00', '20:30',
    'RMV Community Pitch', 22, 14, 'admin_approval', 'admin_controlled',
    2, interval '24 hours', interval '6 hours', interval '19 hours',
    interval '8 hours', array[interval '24 hours', interval '2 hours'],
    '11111111-1111-4111-8111-000000000001'
  ),
  (
    '99999999-9999-4999-8999-000000000002',
    '22222222-2222-4222-8222-000000000001',
    'Wednesday evening 11v11', 3,
    '18:30', '19:00', '20:30',
    'RMV Community Pitch', 22, 14, 'admin_approval', 'admin_controlled',
    2, interval '24 hours', interval '6 hours', interval '19 hours',
    interval '8 hours', array[interval '24 hours', interval '2 hours'],
    '11111111-1111-4111-8111-000000000001'
  ),
  (
    '99999999-9999-4999-8999-000000000011',
    '22222222-2222-4222-8222-000000000002',
    'Thursday 5v5', 4,
    '19:45', '20:00', '21:00',
    'Eastside Indoor Courts', 10, 8, 'first_come', 'automatic',
    2, null, interval '2 hours', interval '4 hours',
    null, array[interval '3 hours'], '11111111-1111-4111-8111-000000000002'
  );

-- Concrete matches. Times are resolved against each league's timezone exactly
-- as create_match() does it, so the seed exercises the same arithmetic the
-- application uses rather than hard-coded UTC literals.
insert into public.matches (
  id, league_id, template_id, title, match_date, timezone,
  arrival_at, kickoff_at, end_at, location_name,
  capacity, min_players, selection_mode, waitlist_mode, team_count,
  priority_window, priority_window_ends_at,
  signup_closes_at, cancellation_cutoff_at, roster_publish_target_at,
  status, public_notes, created_by, published_at
)
select
  seed.id, seed.league_id, seed.template_id, seed.title, seed.match_date, l.timezone,
  (seed.match_date + seed.arrival_time) at time zone l.timezone,
  (seed.match_date + seed.kickoff_time) at time zone l.timezone,
  (seed.match_date + seed.end_time) at time zone l.timezone,
  seed.location_name,
  seed.capacity, seed.min_players, seed.selection_mode, seed.waitlist_mode, 2,
  seed.priority_window,
  case when seed.priority_window is null then null
       else least(now() + seed.priority_window,
                  ((seed.match_date + seed.kickoff_time) at time zone l.timezone)
                    - seed.signup_closes_before) end,
  ((seed.match_date + seed.kickoff_time) at time zone l.timezone) - seed.signup_closes_before,
  ((seed.match_date + seed.kickoff_time) at time zone l.timezone) - seed.cancellation_cutoff_before,
  case when seed.roster_publish_before is null then null
       else ((seed.match_date + seed.kickoff_time) at time zone l.timezone)
              - seed.roster_publish_before end,
  seed.status, seed.public_notes, seed.created_by,
  case when seed.status = 'draft' then null else now() end
from (
  values
    -- An open RMVFC match, a week out.
    ('aaaaaaaa-aaaa-4aaa-8aaa-000000000001'::uuid,
     '22222222-2222-4222-8222-000000000001'::uuid,
     '99999999-9999-4999-8999-000000000001'::uuid,
     'Monday night 11v11', (current_date + 7)::date,
     '18:30'::time, '19:00'::time, '20:30'::time, 'RMV Community Pitch',
     22, 14, 'admin_approval'::public.selection_mode,
     'admin_controlled'::public.waitlist_mode,
     interval '24 hours', interval '6 hours', interval '19 hours',
     interval '8 hours', 'open'::public.match_lifecycle_status,
     'Development sample match.', '11111111-1111-4111-8111-000000000001'::uuid),
    -- A draft, to prove members cannot see it.
    ('aaaaaaaa-aaaa-4aaa-8aaa-000000000002'::uuid,
     '22222222-2222-4222-8222-000000000001'::uuid,
     '99999999-9999-4999-8999-000000000002'::uuid,
     'Wednesday night 11v11 (draft)', (current_date + 9)::date,
     '18:30'::time, '19:00'::time, '20:30'::time, 'RMV Community Pitch',
     22, 14, 'admin_approval'::public.selection_mode,
     'admin_controlled'::public.waitlist_mode,
     interval '24 hours', interval '6 hours', interval '19 hours',
     interval '8 hours', 'draft'::public.match_lifecycle_status,
     null, '11111111-1111-4111-8111-000000000001'::uuid),
    -- An open 5v5 match with a completely different configuration.
    ('aaaaaaaa-aaaa-4aaa-8aaa-000000000011'::uuid,
     '22222222-2222-4222-8222-000000000002'::uuid,
     '99999999-9999-4999-8999-000000000011'::uuid,
     'Thursday 5v5', (current_date + 3)::date,
     '19:45'::time, '20:00'::time, '21:00'::time, 'Eastside Indoor Courts',
     10, 8, 'first_come'::public.selection_mode,
     'automatic'::public.waitlist_mode,
     null, interval '2 hours', interval '4 hours',
     null, 'open'::public.match_lifecycle_status,
     'Development sample match.', '11111111-1111-4111-8111-000000000002'::uuid)
) as seed (
  id, league_id, template_id, title, match_date,
  arrival_time, kickoff_time, end_time, location_name,
  capacity, min_players, selection_mode, waitlist_mode,
  priority_window, signup_closes_before, cancellation_cutoff_before,
  roster_publish_before, status, public_notes, created_by
)
join public.leagues l on l.id = seed.league_id;

insert into public.match_admin_notes (match_id, league_id, notes, updated_by)
values (
  'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  '22222222-2222-4222-8222-000000000001',
  'Development sample note. Members must never be able to read this row.',
  '11111111-1111-4111-8111-000000000001'
);

commit;

# Matchday

Multi-league pickup-sports web application. One account, many leagues: matches,
signup, rosters, waitlists, teams and attendance — configurable per league, not
hard-coded to any one club or format.

RMV Football Club is the first pilot configuration (11v11, 22 players). A 5v5
league with 10 players is equally first-class.

**Current state: the MVP is feature-complete — Phases 1–7.**

- **Phase 1** — authentication, global profiles, leagues, memberships,
  tenant-aware Row Level Security, the audit-event foundation, the
  league-switcher shell.
- **Phase 2** — league creation, private/searchable visibility, public
  discovery through a limited projection, join requests with administrator
  approval, revocable invitation links, manual member addition, atomic
  administrator transfer, league settings, and audit events for every
  administrative change.
- **Phase 3** — versioned league guidelines with immutable acknowledgements and
  a signup-eligibility predicate, reusable match templates, match creation and
  publication, canonical in-app notifications, and opt-in **Web Push** phone
  notifications delivered through a PWA service worker.
- **Phase 3B** — editing a match after publication, with revision tracking and
  change notifications.
- **Phase 4** — first-come and administrator-approved signup, capacity held
  under a match row lock, ordered waitlists, the roster workspace, manual
  additions, and roster publication.
- **Phase 5** — player cancellation with on-time and late classification,
  capacity release, automatic and administrator-controlled promotion, the
  notification inbox with read/archive, and match reminders.
- **Phase 6** — the multi-team builder, count-only randomization, private
  drafts and explicit publication with its own revision.
- **Phase 7** — attendance with five outcomes and corrections, no-show context
  for roster decisions, membership suspension and removal with a cascade,
  completed matches, and the accessibility, mobile and operations passes.

Running it for real is documented in
[`docs/operations/production.md`](docs/operations/production.md) and
[`docs/operations/pilot.md`](docs/operations/pilot.md). What remains is
deployment configuration, not code — see
[`NEXT_STEPS.md`](NEXT_STEPS.md).

The product specification is the source of truth and lives in
[`docs/product/`](docs/product/). Decisions taken after v0.2 are recorded in
[`docs/decisions/`](docs/decisions/).

---

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, React 19, Server Components) |
| Language | TypeScript, `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` |
| Styling | Tailwind CSS 4 |
| Database & auth | Supabase (PostgreSQL, Row Level Security, email magic link / one-time code) |
| Validation | Zod |
| Tests | Vitest — unit, plus integration tests against a real PostgreSQL server |

---

## Getting started

### 1. Install

```bash
npm install
```

Requires Node.js 20.9 or newer.

### 2. Configure environment

```bash
cp .env.example .env.local
```

`.env.example` lists variable **names only**. Fill in `.env.local`, which is
git-ignored.

| Variable | Where it goes | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | Safe to expose |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server | Safe to expose; RLS is what protects data |
| `NEXT_PUBLIC_SITE_URL` | browser + server | e.g. `http://localhost:3000` |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | browser + server | Web Push application server key. Browser-visible by design |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | Bypasses RLS. Never `NEXT_PUBLIC_`, never in a client component |
| `VAPID_PRIVATE_KEY` | **server only** | Signs Web Push. `npx web-push generate-vapid-keys` |
| `VAPID_SUBJECT` | **server only** | `mailto:` contact required by the Web Push protocol |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | browser + server | Optional. Where a blocked user reaches a human; shown in the footer and error boundaries |
| `CRON_SECRET` | **server only** | Shared secret the scheduler presents to `/api/cron/reminders`. Without it reminders never go out |
| `TEST_DATABASE_URL` | tests only | Optional; see [Testing](#testing) |

### 3. Start the local database

Requires [Docker](https://docs.docker.com/get-docker/) and the
[Supabase CLI](https://supabase.com/docs/guides/cli).

```bash
npx supabase start          # boots Postgres, Auth, Studio, and a mail catcher
npm run db:reset            # applies every migration, then supabase/seed.sql
```

`supabase start` prints the API URL and anon key to put in `.env.local`.

Sign-in emails are captured locally at <http://127.0.0.1:54324> and are never
delivered to a real inbox.

### 4. Run the app

```bash
npm run dev                 # http://localhost:3000
```

Sign in with any seeded address, for example `player.multi@matchday.test` — the
player who belongs to both seeded leagues. Open the mail catcher to get the link
or the 6-digit code.

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Every test (unit + database) |
| `npm run test:unit` | Unit tests only — no database needed |
| `npm run test:db` | Database, RLS and tenancy tests |
| `npm run test:concurrency` | Every real-concurrency race, across all phases |
| `npm run test:e2e:fresh` | Resets the database, then the full Playwright suite |
| `npm run db:start` / `db:stop` | Local Supabase stack |
| `npm run db:reset` | Drop, re-migrate and re-seed the local database |
| `npm run db:migrate` | Apply pending migrations |

---

## Database

### Migrations

Forward-only, in `supabase/migrations/`, named `<timestamp>_<snake_case>.sql`.
Never edit a migration that has been applied to a shared environment — add a new
one.

| Migration | Contents |
|---|---|
| `…010000_core_enums` | `league_visibility`, `league_role`, `membership_status`, `selection_mode`, `waitlist_mode` |
| `…010100_utility_functions` | `set_updated_at`, array validation, IANA timezone validation |
| `…010200_profiles` | Global profile; identity columns forced from the session JWT |
| `…010300_leagues` | Tenant root; private by default; configurable capacity and modes |
| `…010400_league_memberships` | Tenancy join; **at most one** active administrator; immutable `league_id`/`user_id` |
| `…010500_single_active_admin` | Deferred constraint trigger: **at least one** active administrator |
| `…010600_league_membership_admin_notes` | Administrator-only notes, held off the member-readable row |
| `…010700_audit_events` | Append-only, league-scoped audit trail |
| `…010800_user_app_state` | Active-league selection, validated against live membership |
| `…010900_authorization_functions` | RLS helpers and `record_audit_event` |
| `…011000_row_level_security` | RLS enabled + forced, and every policy |
| `…011100_grants` | Deny-by-default table privileges |
| `…020000_join_requests_and_invites` | `league_join_requests`, `league_invites` (digest-only tokens) |
| `…020100_public_league_search` | `searchable_leagues_public` — the seven-column public projection |
| `…020200_league_management_functions` | Create, join, decide, invite, redeem, add-by-email, transfer |
| `…020300_audit_triggers` | Audit on every league and membership change, whatever the path |
| `…020400_phase2_rls_and_grants` | Phase 2 RLS, column-level grants, `anon` gets the view only |
| `…020500_harden_admin_cardinality_trigger` | Makes the single-admin check independent of caller RLS |
| `…020600_function_execute_hardening` | Revokes `EXECUTE` from `PUBLIC`; re-grants by name |
| `…030000_guidelines` | `guideline_versions`, `guideline_acceptances`, immutability |
| `…030100_guideline_functions` | Publish/archive/accept + the signup-eligibility predicate |
| `…030200_matches` | Lifecycle enum, transition guard, templates, matches, admin notes |
| `…030300_match_functions` | Create/publish/cancel/edit, with `AT TIME ZONE` resolution |
| `…030400_notifications` | Canonical notifications, idempotent creator, league fanout |
| `…030500_web_push` | Push subscriptions and delivery attempts |
| `…030600_phase3_audit_triggers` | Audit on guideline, template and match changes |
| `…030700_notification_integration` | Attaches fanout to Phase 2 and Phase 3 events |
| `…030800_phase3_rls_and_grants` | Phase 3 RLS, column grants, function EXECUTE |
| `…030900_revoke_public_function_execute` | Takes `EXECUTE` back from `PUBLIC` on Phase 3 functions |
| `…040000_match_editing` | Editing a published match, with revision tracking |
| `…050000–050400` | Phase 4: signups, capacity under lock, waitlists, roster publication |
| `…060000–060400` | Phase 5: cancellation, promotion, reminders, notification inbox |
| `…070000–070400` | Phase 6: teams, draft/published split, team revisions |
| `…080000–080600` | Phase 7: attendance, membership status cascade, two defect fixes |

### Exactly one active league administrator

Two mechanisms, because one is not enough:

- `league_memberships_single_active_admin_key`, a partial unique index, makes a
  **second** active `league_admin` impossible — immediately, per statement.
- `enforce_single_active_league_admin`, a `DEFERRABLE INITIALLY DEFERRED`
  constraint trigger, makes **zero** impossible — checked at `COMMIT`.

Together a league can never be committed with 0 or 2 active administrators, and
a future ownership transfer can demote-then-promote inside one transaction. The
index is deliberately *not* deferrable, so a transfer must vacate the seat before
filling it.

### Row Level Security

Enabled **and forced** on every table in `public`. Deny by default: no matching
policy means zero rows and rejected writes. `anon` holds no table privileges at
all.

| Table | Read | Write |
|---|---|---|
| `profiles` | own row; administrators may read their own league's members | own row only |
| `leagues` | any non-removed membership | league administrator (update only) |
| `league_memberships` | own rows; administrators see their whole league | administrator (update only) |
| `league_membership_admin_notes` | league administrator | league administrator |
| `audit_events` | league administrator | none — `record_audit_event()` or service role only |
| `user_app_state` | own row | own row |
| `league_join_requests` | own requests, or league administrator | none — functions only |
| `league_invites` | league administrator, **minus `token_hash`** | none — functions only |
| `searchable_leagues_public` | **anyone**, including `anon` | — (view) |
| `guideline_versions` | admin: all · member: published | admin: drafts only |
| `guideline_acceptances` | own, or league administrator | none — immutable |
| `match_templates` | league administrator | league administrator |
| `matches` | admin: all · member: published only | admin: drafts only |
| `match_admin_notes` | league administrator | league administrator |
| `notifications` | **recipient only** | none — functions only |
| `push_subscriptions` | own, **minus endpoint and keys** | none — functions only |
| `push_delivery_attempts` | own device only | service role only |

### Public discovery

`searchable_leagues_public` is the only object `anon` may read. It publishes
exactly seven columns — `id`, `slug`, `name`, `general_area`, `sport_label`,
`typical_schedule`, `description` — for leagues whose visibility is
`searchable`. The `leagues` base table stays member-only; publishing a league
never widens it. Withheld on purpose: `default_location` (PRD §12 forbids exact
private locations), `settings_json`, every capacity/threshold/mode default,
`logo_url`, `public_contact` and `created_by`.

### Invitation links

32 bytes from the platform CSPRNG, base64url. The raw token is shown to the
creating administrator **once** and never stored — only `sha256(token)` reaches
the database, hashed inside `create_league_invite()`. Reading `league_invites`,
even as its own administrator, yields nothing redeemable: `token_hash` is
excluded by a column-level grant. Every invitation expires (14 days by default,
90 maximum), can be revoked, and may carry a usage limit. Redemption is
idempotent and does not spend a use for someone who already belongs. A bad,
expired, revoked or exhausted link all fail identically, so a guessed token
cannot confirm that a private league exists.

Policies call `SECURITY DEFINER` helpers (`is_league_member`, `is_active_member`,
`is_league_admin`, `administers_league_of_user`) that break RLS recursion, pin
`search_path = ''`, and answer only about `auth.uid()`.

### Seed data

`supabase/seed.sql` runs as one transaction — the deferred administrator
constraint requires it. It creates:

- **RMV Football Club** — private, capacity 22, administrator-approval selection,
  administrator-controlled waitlist.
- **Weeknight 5v5** — searchable, capacity 10, first-come selection, automatic
  waitlist.
- **`player.multi@matchday.test`** — one player, active in **both** leagues.
- Plus an administrator per league and fixtures covering every membership status
  (`pending`, `active`, `suspended`, `removed`) and a user with no membership.

Safety: every address uses the reserved `.test` TLD, and the file refuses to run
against a database where `matchday.environment` is set to `production`:

```sql
ALTER DATABASE <name> SET matchday.environment = 'production';
```

---

## Testing

```bash
npm test              # everything
npm run test:unit     # fast, no database
npm run test:db       # RLS, tenancy, constraints
```

Unit tests cover pure logic: active-league resolution, profile validation, error
handling, redirect safety, and static secret-hygiene checks.

Database tests run against a **real PostgreSQL server**. They apply the actual
`supabase/migrations/*.sql` and the actual `supabase/seed.sql` — not a copy — and
impersonate users exactly as PostgREST does:

```sql
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"…","role":"authenticated","email":"…"}';
```

By default the harness boots a throwaway PostgreSQL instance itself
(`embedded-postgres`), so `npm test` needs no Docker and no Supabase CLI. To run
against your local Supabase stack instead:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:db
```

A small shim (`tests/db/helpers/auth-shim.sql`) recreates what Supabase provides
before the first migration — the `anon`/`authenticated`/`service_role` roles,
`auth.users`, `auth.identities`, and `auth.uid()`/`auth.jwt()`/`auth.role()`. It
is a test fixture and is never applied to a real database.

---

## Security posture

- **Two independent layers.** Server-side authorization *and* database RLS.
  Neither is trusted to be the only one; UI hiding is never treated as
  authorization.
- **The actor comes from the session.** No helper accepts a user ID, role or
  tenant scope from the caller. `getUser()` revalidates the token with the auth
  server rather than trusting the cookie.
- **Service-role key stays server-side.** Guarded three ways: `server-only`
  imports, an ESLint import restriction, and a runtime check.
- **Tenant-owned rows carry `league_id`.** Enforced `NOT NULL`, with composite
  foreign keys so a child row cannot point at another league's parent.
- **Constraints live in the database.** Capacity ranges, slug format, email
  normalisation, timezone validity, membership uniqueness and administrator
  cardinality are all enforced below the application.
- **Audit events are append-only**, enforced by a trigger, so the rule binds even
  a service-role connection.
- **Errors reveal nothing.** `LEAGUE_NOT_FOUND` and `LEAGUE_PRIVATE` read
  identically, and unexpected errors never surface their text to a client.

---

## Project layout

```
docs/product/       v0.2 specification pack — the product source of truth
docs/decisions/     ADRs for decisions taken after v0.2
supabase/
  migrations/       forward-only SQL migrations
  seed.sql          local development seed
src/
  app/              routes: sign-in, auth callback, onboarding, dashboard,
                    profile, league create/discover/settings/members, invite
  components/       app shell, league switcher, forms
  lib/              env, errors, Supabase clients, auth + authorization, audit
  server/actions/   server actions (auth, profile, active league)
  types/            hand-maintained database types
  proxy.ts          Supabase session refresh (session only — never authorization)
tests/
  unit/             pure logic and static security checks
  db/               RLS, tenancy, constraint and seed tests
```

---

## Guidelines and signup eligibility

A league publishes versioned guidelines. Publishing freezes the text — a trigger
refuses to edit a published body, because members accepted that exact wording;
corrections are new versions. Acceptance is explicit, per-version, and immutable
once recorded.

`public.has_accepted_required_guidelines(league_id)` is the predicate Phase 4's
signup will call. It answers **only about the caller**, so it cannot be used to
probe another member, and it is scoped per league: an unaccepted version in one
league never blocks a match in another.

## Notifications and Web Push

Every alert exists first as a row in `public.notifications` — the canonical
record, readable only by its recipient, keyed for idempotency so a retried
publication cannot notify twice. Web Push delivers *copies* of those records to
opted-in devices.

Push never affects the domain. Delivery runs after the transaction commits,
through an injectable sender, and a failure is recorded as a category and
swallowed. A user who never grants permission, or whose browser has no push
support, loses nothing.

Payloads carry a title, a short body, a validated local path and a notification
id — nothing else, because a payload renders on a lock screen.

## Attendance, and the rule underneath it

After a match ends, the administrator records one of five outcomes for everybody
who was ever confirmed — including anybody who later withdrew, since they still
need an outcome. Corrections are expected: each bumps a revision, tells the
player again, and leaves the previous value in `audit_events` permanently.

**A no-show never disciplines anybody automatically.** Not after two, and not
after twenty. Recording one stores the fact and tells the player; it does not
suspend, remove, block signup, lower priority, change a team assignment or feed
a hidden score. There is no such score anywhere, and a test sweeps
`information_schema` to keep it that way. What the product does instead is show
the administrator the counts beside a name while they choose a roster — no
badge, no colour, no tier, no threshold, because defining one would be the
product deciding something no approved document decides.

## Running it for real

- [`docs/operations/production.md`](docs/operations/production.md) — environment,
  migrations, the health check, the scheduler reminders need, Web Push, and what
  the logs may never contain.
- [`docs/operations/pilot.md`](docs/operations/pilot.md) — setting the pilot
  league up, the rehearsal match, and what to watch.
- [`docs/operations/administrator-recovery.md`](docs/operations/administrator-recovery.md)
  — emergency recovery when a league's sole administrator is locked out.

## Not built yet

Payments, skill ratings, rankings, standings, tournaments, SMS, routine email
beyond the sign-in link, weather integration, guest sponsorship, native apps and
automated data-retention are all out of scope for the MVP. See
[`TODO.md`](TODO.md) and [`NEXT_STEPS.md`](NEXT_STEPS.md).

# Matchday

Multi-league pickup-sports web application. One account, many leagues: matches,
signup, rosters, waitlists, teams and attendance — configurable per league, not
hard-coded to any one club or format.

RMV Football Club is the first pilot configuration (11v11, 22 players). A 5v5
league with 10 players is equally first-class.

**Current state: Phase 1 (foundation) only.** Authentication, global profiles,
leagues, memberships, tenant-aware Row Level Security, the audit-event
foundation and the league-switcher shell. Matches, signup, rosters, waitlists,
teams, notifications and attendance are later phases — see
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
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | Bypasses RLS. Never `NEXT_PUBLIC_`, never in a client component |
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
| `…011100_grants` | Deny-by-default privileges; `anon` gets nothing |

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
  app/              routes: sign-in, auth callback, onboarding, dashboard, profile
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

## Not built yet

League creation UI, invitations, public search, join requests, guidelines,
match templates, matches, RSVP, roster selection, waitlists, notifications,
service workers, Web Push, cancellations, attendance, team building, billing and
native apps are all out of Phase 1 scope. See [`TODO.md`](TODO.md) and
[`NEXT_STEPS.md`](NEXT_STEPS.md).

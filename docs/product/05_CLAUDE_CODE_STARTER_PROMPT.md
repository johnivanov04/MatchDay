# Claude Code Starter Prompt — Matchday Phase 1

Paste the text below into Claude Code from the root of a new repository.

---

You are implementing **Matchday**, a mobile-first, multi-league pickup-sports web application. RMV Football Club is the initial pilot, but the implementation must not be hard-coded to that league, 11v11, or a capacity of 22.

Read these files before changing code:

- `docs/product/01_PRODUCT_REQUIREMENTS_DOCUMENT.md`
- `docs/product/02_FEATURE_SPECIFICATIONS.md`
- `docs/product/03_MVP_ROADMAP.md`
- `docs/product/04_OPEN_QUESTIONS_AND_DECISIONS.md`

Treat those documents as the product source of truth. Where they conflict, stop and explain the conflict instead of guessing.

## Current implementation scope

Implement **Phase 1 only** from the roadmap:

- Next.js with strict TypeScript
- Tailwind CSS
- Supabase Auth using email magic link or one-time code
- Supabase Postgres migrations
- Global user profiles
- Optional phone, gender, preferred positions, goalkeeper willingness, and profile-photo fields
- No skill-level or skill-rating field
- Leagues table
- Private/searchable league visibility field
- League memberships
- Exactly one active `league_admin` per league
- `player` membership role
- Active, pending, suspended, and removed membership states
- One user belonging to multiple leagues
- Active-league selection and a league-switcher shell
- Tenant-aware Row Level Security
- Server-side authorization helpers
- Audit-event foundation
- Development seed containing:
  - One private RMVFC-style league with default capacity 22
  - One searchable 5v5 league with default capacity 10
  - One player who belongs to both leagues
- Automated tests for tenancy and permissions

Do **not** implement the following in Phase 1:

- League creation UI
- League invitations
- Public league search
- Join requests
- Guidelines acknowledgement
- Match templates or matches
- RSVP or roster selection
- Waitlists
- Notifications
- Cancellations
- Attendance
- Team builder
- Billing
- Native apps

## Required working assumptions

- New leagues will default to private when league creation is implemented later.
- A player can belong to multiple leagues.
- A league has exactly one active administrator in the MVP.
- Administrative ownership will be transferable in a later phase.
- League-owned rows must include or securely derive `league_id`.
- The client must never be trusted to provide the current actor, role, or tenant scope.
- Email is used for authentication.
- Notification delivery scope remains outside Phase 1.

## Engineering requirements

1. Use strict TypeScript.
2. Do not expose service-role keys or secrets to the browser.
3. Derive the current actor from the authenticated server session.
4. Enforce authorization through both server checks and database RLS.
5. Include a database-level rule that prevents more than one active administrator per league.
6. Add indexes for common membership and league queries.
7. Keep migrations forward-only and clearly named.
8. Add `.env.example` with variable names only.
9. Provide a safe, documented local seed path.
10. Add tests from the beginning.
11. Do not weaken assertions or skip tests to make the build pass.
12. Do not commit or push changes.

## Deliverables

- Working project structure
- Database migrations and constraints
- RLS policies
- Auth and callback screens
- Global profile onboarding
- Authenticated application shell
- League-switcher shell
- Seed data for two leagues and a multi-league player
- Authorization utilities
- Unit/integration tests for Phase 1
- Updated `README.md`
- `TODO.md`
- `NEXT_STEPS.md`

## Required validation

Run and report exact commands and results for:

- Dependency installation
- Lint
- TypeScript type-check
- Unit/integration tests
- Production build
- Supabase reset, migrations, and seed commands when local Supabase is used

## Before coding

First provide:

1. Concise implementation plan
2. Proposed directory structure
3. Proposed tables, constraints, indexes, and RLS policy summary
4. How the single-active-administrator constraint will be enforced
5. How cross-league isolation will be tested
6. Any blocking conflicts

Then implement only after confirming there are no blocking conflicts.

## After coding

Stop after Phase 1 and provide:

1. File-by-file summary
2. Migration and RLS summary
3. Test list and exact results
4. Remaining risks
5. Next recommended task from Phase 2

Do not begin Phase 2.

---

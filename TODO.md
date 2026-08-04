# TODO

Open work, ordered by phase. Phase numbers follow
[`docs/product/03_MVP_ROADMAP.md`](docs/product/03_MVP_ROADMAP.md).

Phase 1 is complete; what remains below it is either deliberately deferred or
newly discovered while building the foundation.

---

## Carried over from Phase 1 (deliberately deferred)

- [ ] **Gender field values.** No product document enumerates them, so `gender`
      is stored as constrained free text (≤64 characters) rather than inventing a
      taxonomy. Decide whether leagues need a controlled vocabulary before the
      team builder surfaces gender distribution in Phase 6.
- [ ] **Profile photo upload.** Phase 1 ships `profile_photo_url` only, matching
      `02 §17`. Uploading needs a Supabase Storage bucket, per-user object
      policies, and image size/type validation.
- [ ] **Administrator notes UI.** `league_membership_admin_notes` exists with
      administrator-only RLS but has no interface; it is written to only by the
      seed.
- [ ] **Generated database types.** `src/types/database.ts` is hand-maintained.
      Replace with `supabase gen types typescript --local` once a Supabase
      project exists. The database test suite already asserts the real column set
      against a real server, so drift is caught.
- [ ] **Seeded placeholder copy.** `general_area` and `typical_schedule` for
      RMV Football Club are plausible placeholders, not the club's real details.
      Replace before the pilot.
- [ ] **PostgreSQL version parity.** The test harness runs PostgreSQL 18;
      `supabase/config.toml` pins `major_version = 17` to match hosted Supabase.
      Re-run `npm run test:db` against `TEST_DATABASE_URL` pointing at the local
      Supabase stack before the first deployment.

## Phase 2 — League creation, invitations, discovery, join requests

- [ ] `createLeague` as a single transactional function: insert the league **and**
      its administrator membership together. The deferred constraint trigger
      rejects a league committed without exactly one active administrator, so
      this cannot be two separate statements.
- [ ] `transferLeagueAdministration`, demoting the outgoing administrator
      **before** promoting the incoming one. The partial unique index is not
      deferrable; see `tests/db/single-active-admin.test.ts` for both orderings.
- [ ] `league_join_requests` table, with a unique active-pending request per
      league and user.
- [ ] `league_invites` table: hashed token, expiry, usage limit, revocation.
- [ ] Public search projection — a **view** exposing only name, general area,
      sport label, typical schedule and description for `searchable` leagues.
      Do not widen the `leagues` RLS policy to achieve it.
- [ ] `anon` grants for that view only. Everything else stays denied.
- [ ] INSERT policies for `league_memberships` once joining exists.
- [ ] Manual member addition by email.
- [ ] League settings screen, with an audit event on every change (the write path
      already exists: `recordAuditEvent`).
- [ ] Move `eligibility_notes` handling into the admin-notes table's UI rather
      than onto the membership row — see the note in
      `20260803010600_league_membership_admin_notes.sql`.

## Phase 3 — Guidelines, templates, matches, in-app notifications

- [ ] `guideline_versions` and `guideline_acceptances`.
- [ ] `match_templates` and `matches`.
- [ ] In-app notification centre with idempotency keys.
- [ ] Keep notification events channel-independent — Web Push arrives later
      (see [ADR 0001](docs/decisions/0001-notifications-in-app-center-plus-web-push.md)).

## Phase 4–7

- [ ] Signup, capacity transactions, ordered waitlist (Phase 4).
- [ ] Cancellation, promotion, reminders (Phase 5).
- [ ] Team builder and publication (Phase 6).
- [ ] Attendance, no-show warnings, PWA manifest, monitoring (Phase 7).

## Future requirement — Web Push

Decided 2026-08-03, **not** implemented in Phase 1. See
[ADR 0001](docs/decisions/0001-notifications-in-app-center-plus-web-push.md).

- [ ] `push_subscriptions` table (user-owned, RLS-protected).
- [ ] Service worker and PWA manifest — required before push works on iOS.
- [ ] VAPID keys as server-only secrets, same posture as the service-role key.
- [ ] Delivery-attempt logging, retries, stale-endpoint pruning.
- [ ] Permission UX asked at a moment the user understands.
- [ ] Payload discipline: push renders on a lock screen, so it must carry no
      roster, attendance, disciplinary or gender information.

## Engineering backlog

- [ ] Playwright end-to-end tests (`02 §23` lists eight journeys).
- [ ] Component tests for the league switcher and forms.
- [ ] Concurrency tests for capacity and waitlist promotion (Phase 4 — the
      hardest correctness requirement in the product).
- [ ] Error monitoring and structured logging that excludes gender, attendance
      and disciplinary data.
- [ ] Rate limiting on the sign-in endpoint.
- [ ] Accessibility audit once there are real screens to audit.

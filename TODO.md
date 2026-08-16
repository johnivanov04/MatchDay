# TODO

**All seven MVP phases are implemented.** What is left is deliberately deferred
work, the post-MVP backlog, and the deployment configuration that cannot be done
from inside this repository.

Phase numbers follow
[`docs/product/03_MVP_ROADMAP.md`](docs/product/03_MVP_ROADMAP.md). The sections
below marked *complete* are kept as a record of what each phase closed, not as
open work.

Before the pilot, read
[`docs/operations/production.md`](docs/operations/production.md) and
[`docs/operations/pilot.md`](docs/operations/pilot.md) — they are the current
list of what an operator must actually do.

---

## Before the RMVFC pilot — external configuration only

None of these is a code change. See `docs/operations/production.md`.

- [ ] Set `CRON_SECRET` on the deployment and confirm the `vercel.json` cron
      entry is registered and invoking successfully. **Reminders do not go out
      until this is done**, and on a Hobby plan the ten-minute cadence needs an
      upgrade.
- [ ] Set `NEXT_PUBLIC_SUPPORT_EMAIL` so a blocked player has a route to a
      human.
- [ ] Set `REMINDER_HEARTBEAT_URL` in Production so an outside observer watches
      the reminder scheduler. Unset, the cron still works but nothing notices if
      it stops — and a deployment that stops running crons cannot notice its own
      silence.
- [ ] Configure a real SMTP sender in Supabase Auth. Sign-in is magic-link only
      and the built-in sender is rate-limited to a handful of messages an hour.
- [ ] Confirm backup retention on the Supabase plan, and rehearse one restore.
- [ ] Configure a **Vercel Log Drain to Better Stack** and set the alerts listed
      in `production.md` §7. Page on `action.dependency_failed`,
      `action.failed` (`severity: "unexpected"`) and `reminder.failed`; graph
      but never page on `action.rejected_input` and `action.refused`. Above all,
      alert on the *absence* of `reminder.run`.
- [ ] Replace the placeholder `general_area` and `typical_schedule` copy for RMV
      Football Club with the club's real details.

## Security follow-ups found while building Phase 2

Two defects were found by Phase 2's own tests and fixed forward. Both are worth
remembering as patterns rather than one-off bugs:

- **Integrity triggers must not depend on the caller's RLS.**
  `enforce_single_active_league_admin()` was not `SECURITY DEFINER`, so its
  "was this league deleted?" guard was answered by the caller's visibility. An
  administrator who removed their own membership made the league invisible to
  themselves, the guard skipped the check, and the league could commit with zero
  administrators. Fixed in `20260803020500`. Audit any future trigger that reads
  a table for the same mistake.
- **An expected authorization outcome must be a redirect, not a throw, inside a
  render.** This has now bitten three times: `PROFILE_INCOMPLETE` on the
  dashboard (Phase 1), and `NOT_LEAGUE_ADMIN` on the members and settings pages
  after an administration transfer (Phase 2). A `DomainError` escaping a Server
  Component is reported by Next.js as an unhandled application error — the user
  sees a 500 even though the app behaved correctly. Server actions keep the
  throwing helpers (`requireLeagueAdmin`) because they turn them into an
  `ActionResult`; pages use the redirecting guards in `@/lib/auth/page-guards`.
  **Any new admin-only route must use `requireLeagueAdminPage()`.**
- **An action that revokes the caller's own access to the current route must
  `redirect()`, not just `revalidatePath()`.** Revalidation re-renders the route
  the caller is standing on, which is exactly the one they just lost. And the
  `redirect()` must sit outside the action's try/catch, or `actionFailure`
  swallows the `NEXT_REDIRECT` signal and turns a success into a generic error.
- **`ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE … FROM PUBLIC` silently did
  nothing.** Phase 2 used it to try to make new functions unreachable by
  default, and recorded no `pg_default_acl` row, so every Phase 3 function
  shipped with the built-in `EXECUTE` grant to `PUBLIC` — including the
  worker-only `record_push_delivery_result`, which could then be used to switch
  off another person's phone notifications. Fixed in `20260805030900` with an
  explicit revoke plus an in-function actor check. **Do not trust default
  privileges**: `tests/db/schema.test.ts` now asserts directly that no function
  in `public` grants `EXECUTE` to `PUBLIC`, and that assertion is the control.
- **`REVOKE ... FROM anon, authenticated` does not remove a function's `PUBLIC`
  grant.** PostgreSQL grants `EXECUTE` to `PUBLIC` by default, so the revokes in
  the Phase 1 grants migration had no effect and the unchecked audit writer was
  callable by any signed-in user. Fixed in `20260803020600`, which revokes from
  `PUBLIC` and re-grants by name.

## Carried over from Phase 1 (deliberately deferred)

- [ ] **Gender field values.** No product document enumerates them, so `gender`
      is stored as constrained free text (≤64 characters) rather than inventing a
      taxonomy. The Phase 6 team builder shows gender only when a league enables
      the field, so this is not blocking; decide before any league relies on it.
- [x] **Profile photo upload.** Done: the public `avatars` bucket with
      select/insert/delete-own policies, `profiles.profile_photo_path`, and
      on-device resize to a 512x512 JPEG. `profile_photo_url` is kept for legacy
      rows, still rendered, no longer editable.
- [ ] **Avatars beyond the profile page.** The upload flow ships alone by
      design — rosters, the team builder, published teams, member lists and the
      attendance register still show names only. Deferred until the upload flow
      has been used on a physical iPhone.
- [ ] **Administrator notes UI.** `league_membership_admin_notes` exists with
      administrator-only RLS but has no interface; it is written to only by the
      seed.
- [ ] **Generated database types.** `src/types/database.ts` is hand-maintained.
      Replace with `supabase gen types typescript --local` once a Supabase
      project exists. The database test suite already asserts the real column set
      against a real server, so drift is caught.
- [ ] **Seeded placeholder copy.** `general_area` and `typical_schedule` for
      RMV Football Club are plausible placeholders, not the club's real details.
      Replace before the pilot — tracked in the pilot checklist above.
- [x] **PostgreSQL version parity.** The test harness runs PostgreSQL 18;
      `supabase/config.toml` pins `major_version = 17` to match hosted Supabase.
      `npm run test:db` has been run against `TEST_DATABASE_URL` pointing at the
      local Supabase stack — 911 tests pass on the 17-series server.

## Phase 2 — complete

Delivered: transactional `create_league`, atomic administrator transfer,
`league_join_requests`, `league_invites` with digest-only tokens, the
`searchable_leagues_public` projection, `anon` grants limited to that view,
manual member addition, the league settings screen, and audit triggers covering
every league and membership change.

Carried forward from Phase 2:

- [ ] **Account-existence oracle in add-by-email.** `add_league_member_by_email()`
      necessarily reveals whether an address has a Matchday account, and anyone
      can create a league to become an administrator. F-03 requires the feature.
      Mitigation to consider: rate-limit per administrator, and offer
      "invite by email" that sends a link and reports success either way.
- [ ] **No rate limiting** on league creation, join requests or invite
      redemption. A single account can create unlimited leagues and burn invite
      guesses without penalty. Redemption guessing is not a realistic threat at
      256 bits, but the endpoints deserve a limiter.
- [ ] **Administrator notes UI** still absent; `league_membership_admin_notes`
      remains written only by the seed.
- [ ] **Slug changes are not offered** in the settings form, so a league's
      address is fixed after creation. Add a rename flow with redirect handling
      if leagues ask for it.
- [ ] **Invite links are not emailed.** The administrator copies the link and
      distributes it. Sending it requires the email infrastructure that Phase 3
      notifications will introduce.
- [ ] Move `eligibility_notes` handling into the admin-notes table's UI rather
      than onto the membership row — see the note in
      `20260803010600_league_membership_admin_notes.sql`.

## Phase 3 — complete

Delivered: versioned guidelines with immutable acknowledgements and the
signup-eligibility predicate, match templates and matches with database-side
timezone resolution, canonical in-app notifications, and opt-in Web Push.

Carried forward from Phase 3:

- [ ] **Real PWA icons.** The manifest ships an SVG with `sizes: "any"`.
      Generate 192px and 512px PNGs (including a maskable variant) before
      relying on home-screen install on Android.
- [ ] **Push delivery is inline, not queued.** `dispatchPushForKeyPrefix` runs
      inside the request that published the match. It cannot fail the domain
      operation, but a large league means a slow response. Move it to a queue
      or a background function before a league grows past a few dozen members.
- [ ] **No retry scheduler.** A `temporary_failure` is recorded and left. There
      is nothing that comes back to retry it; `push_delivery_attempts` holds
      everything a worker would need.
- [ ] **Reminder scheduling is stored, not executed.** `reminder_offsets` on a
      template is future-compatible metadata; the scheduler is Phase 5.
- [ ] **Notification retention.** 04 §3 suggests 90 days in the default UI.
      Nothing prunes or paginates yet; `archived_at` exists for it.
- [ ] **Per-type notification preferences.** One enabled/disabled switch per
      device is the whole model, deliberately. Revisit only if members ask.

## Phase 4 — complete

Delivered: `match_signups` with composite-FK tenancy and a deferrable waitlist
constraint, one central eligibility predicate, first-come and
administrator-approved signup, transactional capacity claiming under a match-row
lock, ordered waitlists with validated reordering, manual administrator
additions, roster publication with its own revision counter, the member roster
projection and the administrator workspace.

Carried forward from Phase 4:

- [ ] **`published_status` is a denormalised copy.** It records what each player
      was last told so republication can find who actually moved. It is written
      only by `finalize_roster()`; if a future path writes signups without going
      through it, the "affected player" calculation silently degrades.
- [ ] **Reordering submits the whole list.** Fine for a pickup waitlist; a
      league with a hundred waitlisted players would want a move-one operation
      with a position hint rather than an N-element array.
- [ ] **No priority-window enforcement.** `priority_qualified` is recorded and
      shown to the administrator as a flag, per 02 §11 — "Optional priority
      rules create warnings, not universal automatic entitlement." Nothing acts
      on it automatically, which is deliberate.
- [ ] **First-come matches never need publication.** `finalize_roster()` accepts
      them, but nothing requires it, because F-06 makes their roster
      authoritative on join. Revisit if a league asks to freeze one.
- [ ] **Open-spot visibility has no league setting.** F-08 mentions one; no
      column exists, so open spots are shown to every active member.

## Phase 5 — complete

Delivered: `cancel_spot()` with database-side on-time/late classification,
transactional capacity release, automatic waitlist promotion, the
administrator-controlled replacement workflow, cancellation receipts and
late-cancellation alerts, durable reminders with a claim-based generator, and
the remaining notification-centre mutations.

Carried forward from Phase 5:

- [ ] **No scheduler is configured.** `POST /api/cron/reminders` and
      `npm run reminders:run` both exist; nothing calls either on a cadence.
      Until an operator wires up Vercel Cron or `pg_cron`, reminders do not go
      out. This is the single most important operational gap in the product.
- [ ] **The two deadlines round opposite ways.** Cancelling *at*
      `cancellation_cutoff_at` is on time (`now() > cutoff` is late), while
      signup treats `now() >= signup_closes_at` as closed. Both are tested and
      deliberate, but a product decision should settle whether they agree.
- [ ] **Reminders go to confirmed players only.** A "respond before signup
      closes" nudge for members who have not answered is an obvious second
      reminder kind and needs a recipient rule of its own.
- [ ] **`reminder_offsets` has no interface.** It is copied from the template to
      the match, but `saveMatchTemplateAction` still writes `[]`, so an
      administrator cannot configure reminders without SQL.
- [ ] **A promoted player who then cancels cannot be re-promoted.** The
      `waitlist_promotion:<match>:<membership>` key is one per player per match,
      so a second promotion of the same person would not notify.
- [ ] **`replacement_needed` is not re-sent** if the administrator ignores it.
      One vacancy, one alert; there is no escalation or reminder of the alert.

## Phase 6 — complete

- [x] Team builder: 2–20 teams, names and labels, manual assignment, count-only
      randomization that never claims balance.
- [x] Private drafts, explicit publication, a distinct `team_revision`, and a
      new snapshot whenever a cancellation changes what players can see.

## Phase 7 — complete

- [x] Attendance: five outcomes, corrections with full audit history, the
      durable `confirmed_at` participation marker.
- [x] No-show context on the roster workspace — counts and a date, never a
      threshold, tier or score.
- [x] Membership suspension/removal with a reason and a future-match cascade.
- [x] `completed` match lifecycle; accessibility, mobile and operations passes.

## Web Push — complete (Phase 3)

Decided 2026-08-03, delivered in Phase 3. See
[ADR 0001](docs/decisions/0001-notifications-in-app-center-plus-web-push.md).

- [x] `push_subscriptions` table (user-owned, RLS-protected).
- [x] Service worker and PWA manifest, plus the PNG and apple-touch icons.
- [x] VAPID keys as server-only secrets, same posture as the service-role key.
- [x] Delivery-attempt logging, retries and stale-endpoint invalidation.
- [x] Permission requested only on a deliberate tap, never on page load.
- [x] Payload discipline: `PUSH_ELIGIBLE_TYPES` is authoritative, and attendance
      is deliberately excluded because a payload renders on a lock screen.

## Engineering backlog

- [x] Playwright end-to-end tests — 149 specs across all seven phases.
- [x] Concurrency tests for capacity and waitlist promotion — 33 races.
- [x] Structured logging that excludes gender, attendance and disciplinary data
      (`src/lib/observability/log.ts` refuses forbidden keys by type).
- [x] Accessibility audit — axe against ten populated pages, plus the checks axe
      cannot make.
- [ ] Component tests for the league switcher and forms.
- [ ] Rate limiting on the sign-in endpoint. Supabase Auth applies its own
      limits; this is about the application surface in front of it.
- [ ] Automated data-retention and deletion. Removing a member's data is a
      manual database operation today — fine for a 22-player pilot, a blocker
      for anything wider.
- [ ] `teams_published` is a `match_lifecycle_status` value nothing can reach.
      Phase 6 settled that publication is metadata; either implement it or drop
      the enum value rather than leaving it looking implemented.

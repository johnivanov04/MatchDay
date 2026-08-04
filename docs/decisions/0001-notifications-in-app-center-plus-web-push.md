# ADR 0001 — Notifications: in-app centre **plus** operating-system Web Push

- **Status:** Accepted
- **Date:** 2026-08-03
- **Supersedes:** the open question in `docs/product/04_OPEN_QUESTIONS_AND_DECISIONS.md` §2
- **Applies to:** a future phase. **Nothing in this ADR is implemented in Phase 1.**

## Context

The v0.2 specification pack left one blocking product question open. `PRD §6`
recorded that "whether 'app notification' also means operating-system push
notifications is still an open decision", `04 §2` presented the two options, and
`docs/product/README.md` listed it as the current unresolved decision.

The two options were:

- **A.** In-app notification inbox only.
- **B.** In-app inbox **plus** Web Push, so a notification can reach a phone
  while the app is closed.

`PRD §14` names the underlying risk directly: "in-app notifications are not
noticed when the app is closed". For a product whose core job is collecting a
response to a match invitation before a deadline, a notification nobody sees is
a notification that failed.

## Decision

**Option B.** The eventual product supports an in-app notification centre
**and** real operating-system notifications delivered through Web Push.

The in-app notification centre remains the **source of truth**. Web Push is a
delivery channel layered on top of it, never a parallel store. A user who never
grants push permission must lose no information.

## Scope and sequencing

This decision is recorded as a **future requirement**. It is deliberately not
built yet:

- **Phase 1 (this phase):** no notifications, no service worker, no push
  subscriptions, no Web Push, no permission prompts. None of the above appear
  anywhere in the codebase.
- **Phase 3:** the in-app notification centre, as already specified in
  `03_MVP_ROADMAP.md` §6. Notification events stay channel-independent.
- **A later phase:** Web Push delivery on top of the same events.

## Consequences

Work this creates when the notification phases arrive:

1. A `push_subscriptions` table — endpoint, keys, user, device label, created
   and last-seen timestamps — that is user-owned and RLS-protected exactly like
   every other user-scoped table.
2. A service worker, and a PWA manifest. `03_MVP_ROADMAP.md` §10 already
   schedules the manifest for Phase 7; Web Push may pull it earlier, because on
   iOS a site generally must be installed to the home screen before push works
   at all.
3. VAPID keys held as server-only secrets, in the same posture as
   `SUPABASE_SERVICE_ROLE_KEY`: never `NEXT_PUBLIC_`, never in a client bundle.
4. A delivery-attempt log, plus retry and expiry handling — push endpoints go
   stale and must be pruned.
5. Permission UX that asks at a moment the user understands, not on first load.
6. Notification payload discipline. A push payload surfaces on a lock screen,
   so it must carry no roster, attendance, disciplinary or gender information —
   only enough to bring the user into the app. This is the same rule as
   `PRD §12`, applied to a surface outside the app.

Consequences already honoured by the Phase 1 foundation:

- Notification events must remain channel-independent, so the domain layer
  never learns whether a given user has push enabled. Phase 1 introduces no
  domain logic that would have to change.
- Every notification is league-scoped, so the tenancy model built in Phase 1 —
  `league_id` on every tenant-owned row, RLS derived from
  `league_memberships` — already covers it.

## Alternatives considered

- **Option A (in-app only).** Lower complexity, and enough to ship a pilot. It
  was rejected as the *end state* because it does not solve the problem the
  product exists to solve. It nonetheless remains the correct **first**
  increment, which is why the in-app centre ships before push.
- **Email as the alert channel.** Rejected as a general solution: `PRD §3` opens
  with "match invitations are easy to miss in email or group chats". Email stays
  limited to authentication.

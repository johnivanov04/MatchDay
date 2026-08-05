# ADR 0001 — Notifications: in-app centre **plus** operating-system Web Push

- **Status:** Accepted — **implemented in Phase 3** (2026-08-05)
- **Date:** 2026-08-03; scope amended 2026-08-05
- **Supersedes:** the open question in `docs/product/04_OPEN_QUESTIONS_AND_DECISIONS.md` §2
- **Amends:** `03_MVP_ROADMAP.md` §6, which scoped Phase 3 to in-app notifications
  only, and §12, which listed Web Push as post-MVP

> **Amendment, 2026-08-05.** This ADR originally deferred Web Push to "a later
> phase". The approved product decision brought it forward: the product must
> support real operating-system phone notifications, and both the in-app centre
> and Web Push were delivered together in Phase 3. Web Push is **no longer
> unresolved, optional, or future work** anywhere in this repository. The
> decision below is unchanged; only its timing was.

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

Delivered as follows:

- **Phase 1:** nothing. No notifications, service worker, push subscriptions or
  permission prompts existed in the codebase.
- **Phase 2:** nothing, beyond the league and membership events that Phase 3
  later attached notifications to.
- **Phase 3 (both halves, shipped together):**
  - **3C** — the canonical in-app notification centre. `public.notifications`
    is the source of truth for every alert, with recipient-only RLS,
    idempotency keys, an unread count and an inbox.
  - **3D** — Web Push as a delivery channel on top of it: a PWA manifest, a
    service worker, per-device opt-in subscriptions, VAPID server-only signing,
    and delivery bookkeeping with temporary/permanent failure classification.

The layering held: no SQL function knows that push exists. Delivery reads
canonical notifications after the domain transaction has committed, and a push
failure cannot roll back a publication or lose an in-app notification.

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

How each consequence was actually met in Phase 3:

1. `public.push_subscriptions` — per user, per device, with `endpoint`,
   `p256dh` and `auth_secret` excluded from every client grant, because
   together they are a bearer credential for that device.
2. `src/app/manifest.ts` and `public/sw.js`. Real PNG icons remain a manual
   follow-up; the manifest currently ships an SVG.
3. `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` are server-only and are named in
   exactly one module, which `tests/unit/secret-hygiene.test.ts` asserts.
   `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is browser-visible by design.
4. `public.push_delivery_attempts` records status, attempt count and a failure
   *category* — never a provider response, which can embed the endpoint.
   404/410 retires the subscription; ten consecutive temporary failures retires
   it too.
5. Permission is requested only from an explicit "Enable phone notifications"
   button, never on load.
6. `buildPushPayload()` constructs four fields by hand rather than spreading a
   row, so there is no object that could widen. A test asserts that roster,
   attendance, gender, phone and administrator-note values cannot appear.

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

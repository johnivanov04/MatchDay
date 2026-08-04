# Decision Log — Matchday

## 2026-08-03 — Notification delivery resolved: in-app centre plus Web Push

### Context

The v0.2 pack left one blocking question open: whether “app notification” means
an in-app inbox only, or an in-app inbox plus operating-system push. `PRD §14`
records the underlying risk — “in-app notifications are not noticed when the app
is closed” — which matters for a product whose core job is collecting a response
before a deadline.

### Decision

The eventual product supports **an in-app notification centre plus real
operating-system phone notifications through Web Push**. The in-app centre is
the source of truth; Web Push is a delivery channel on top of it, so a user who
never grants push permission loses no information.

### Scope

Recorded as a **future requirement**, deliberately not yet built:

- **Phase 1:** nothing. No notifications, service workers, push subscriptions,
  Web Push or permission prompts exist in the Phase 1 codebase.
- **Phase 3:** the in-app notification centre, as already planned.
- **A later phase:** Web Push delivery.

### Consequences

- A `push_subscriptions` table, a service worker, a PWA manifest, VAPID
  server-only secrets, delivery-attempt logging and stale-endpoint pruning are
  all added to the backlog.
- Push payloads must carry no roster, attendance, disciplinary or gender detail,
  since they render on a lock screen (`PRD §12`, applied outside the app).
- Notification events stay channel-independent, so no domain logic needs to
  change when push is added.
- `03_MVP_ROADMAP.md` §12 lists “Web Push, when not included in MVP” as
  post-MVP; it is now a committed future requirement rather than an option.

Full record:
[`docs/decisions/0001-notifications-in-app-center-plus-web-push.md`](../decisions/0001-notifications-in-app-center-plus-web-push.md).

---

## 2026-08-03 — Product scope revision

### Context

The original specification was centered on RMV Football Club. The product is now intended for multiple independent pickup leagues.

### Decisions

- Multi-league architecture is required from MVP foundation.
- Private leagues are default; administrators can enable searchable discovery.
- Players can belong to multiple leagues.
- Each league has one administrator and players.
- Capacity, minimum turnout, deadlines, selection mode, waitlist mode, and team count are configurable.
- Support first-come and administrator-approved signup.
- Support automatic and administrator-controlled waitlist promotion.
- Members can see the full confirmed roster.
- Player profile includes position, gender, and goalkeeper willingness; no skill level.
- Administrator creates teams and may use count-based randomization.
- Teams are visible only after publication.
- Attendance and no-show warnings are recorded without automatic suspension.
- Players can cancel at any time; late cancellations are flagged.
- Administrator can manually add players to rosters and waitlists.
- Data model supports more than two teams.
- Dedicated guest sponsorship is deferred.
- Notification source of truth is in-app; operating-system Web Push remains unresolved.

### Consequences

- Tenancy and RLS must be implemented in the first phase.
- Multi-club support is no longer a post-MVP item.
- The product name is changed from `RMVFC Matchday` to the generic working name `Matchday`.
- The roadmap estimate increases because discovery, join requests, and tenant isolation are core scope.

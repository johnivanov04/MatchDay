# Decision Log — Matchday

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

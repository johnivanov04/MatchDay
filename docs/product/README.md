# Matchday Product Specification Pack

This folder contains the current product and implementation plan for **Matchday**, a mobile-first application for pickup leagues to manage membership, matches, signup, rosters, waitlists, teams, notifications, cancellations, and attendance.

RMV Football Club is the first pilot configuration. The product is designed for multiple leagues and configurable formats such as 11v11 with 22 players or 5v5 with 10 players.

## Files

1. `01_PRODUCT_REQUIREMENTS_DOCUMENT.md` — product goals, decisions, journeys, requirements, privacy, risks, and release definition.
2. `02_FEATURE_SPECIFICATIONS.md` — implementation-oriented feature behavior, data model, authorization, acceptance criteria, and tests.
3. `03_MVP_ROADMAP.md` — phased build plan and pilot sequence.
4. `04_OPEN_QUESTIONS_AND_DECISIONS.md` — resolved decisions and the remaining notification question.
5. `05_CLAUDE_CODE_STARTER_PROMPT.md` — prompt for Claude Code to implement Phase 1 only.
6. `06_DECISION_LOG.md` — dated record of the product-scope revision.

## Recommended use with Claude Code

1. Create a new repository.
2. Copy this folder to `docs/product/`.
3. Open Claude Code from the repository root.
4. Paste `05_CLAUDE_CODE_STARTER_PROMPT.md`.
5. Review Claude's plan, schema, and RLS summary before implementation.
6. Require Claude to stop after Phase 1 and report exact validation results.
7. Review the implementation before starting the next roadmap phase.

## Notification decision — resolved 2026-08-03

The previously open notification question has been decided: the eventual product
supports **an in-app notification centre plus operating-system notifications via
Web Push**. The in-app centre is the source of truth; Web Push is a delivery
channel layered on top of it.

**Both halves were implemented in Phase 3** (2026-08-05): the canonical in-app
notification centre and opt-in Web Push phone notifications. Web Push is no
longer unresolved or future work. The domain layer stays channel-independent —
no database function knows push exists; delivery reads canonical notifications
after the fact.

See [`docs/decisions/0001-notifications-in-app-center-plus-web-push.md`](../decisions/0001-notifications-in-app-center-plus-web-push.md)
and [`docs/decisions/0002-same-match-re-entry-after-cancellation.md`](../decisions/0002-same-match-re-entry-after-cancellation.md)
and the dated entry in `06_DECISION_LOG.md`.

## Source material

The initial RMVFC configuration is based on the supplied club guidelines. Those rules should be stored as league-specific settings and versioned guideline content rather than universal application logic.

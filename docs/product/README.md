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

## Current unresolved decision

Determine whether the MVP notification experience is:

- an in-app notification inbox only, or
- an in-app inbox plus Web Push notifications that can appear while the app is closed.

The schema and domain service should remain channel-independent either way.

## Source material

The initial RMVFC configuration is based on the supplied club guidelines. Those rules should be stored as league-specific settings and versioned guideline content rather than universal application logic.

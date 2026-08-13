# ADR 0002 — Re-entering the same match after cancelling

- **Status:** Accepted — **implemented in Phase 7** (2026-08-17)
- **Date:** 2026-08-17
- **Fills a gap in:** `02_FUNCTIONAL_SPECIFICATION.md` §9 and §16, which define
  cancellation and attendance but never say what happens if somebody who
  cancelled wants back into the *same* match
- **Related:** ADR 0001 (notifications), `docs/operations/pilot.md` §4

## Context

Until Phase 7 this question had an answer nobody chose: **you could not**.

`cancel_spot()` wrote `canceled_at` and `cancellation_reason`, and
`match_signups_cancellation_fields_reserved` requires that a row carrying those
fields is `canceled` or `withdrawn_late`. No path back cleared them, so every
route failed with a check-constraint violation:

| Route | Result before Phase 7 |
|---|---|
| `join_match()` — the player changes their mind | `23514` |
| `add_member_to_match()` — an administrator re-adds them | `23514` |
| `set_signup_decision()` — an administrator confirms them | `23514` |
| `promote_waitlisted_player()` — an administrator promotes them | `23514` |

A cancellation was therefore permanent, in a product whose subject is people
dropping in and out of pickup matches. "I cancelled, then my evening freed up"
is not an edge case for a five-a-side league; it is Tuesday. This was a defect
rather than a decision — no document proposed it, and the constraint that
produced it is correct and stays.

Fixing it forces the question the specification never answered: **what does
re-entry mean, and what happens to the record of the cancellation?**

## Decision

**A member who cancelled may re-enter the same match, through every ordinary
route, subject to every ordinary rule. The live signup row describes only the
current state; the history of what happened is never erased.**

### A. Which states may re-enter

| From | May re-enter | Why |
|---|---|---|
| `canceled` (on time) | **yes** | They withdrew within the rules and changed their mind |
| `withdrawn_late` | **yes** | See below |
| `not_selected` | **no change** | Not a withdrawal. Asking again returns the standing decision |
| `unavailable` | n/a | Holds nothing; signing up was always available |

**A late withdrawal does not lock anybody out.** This is the load-bearing
choice. `withdrawn_late` is a *fact about a past decision*, not a sanction —
04 §1 settles that the product records facts and warns, and the administrator
decides. A product-imposed lockout would be an automatic penalty, the exact
thing `docs/operations/pilot.md` §4 forbids, and no approved document defines
one. An administrator who wants that outcome removes the player from the match
themselves.

`request_spot()` on a `not_selected` row is **idempotent, not an error**: it
returns the standing decision. Phase 4's rule that a re-tap "never overwrites a
decision the administrator has already made" is unchanged, and re-entry is not
a route around it.

### B. Player-driven re-entry obeys every ordinary rule

Re-entry is an ordinary signup, not a privileged restoration. `join_match()`
and `request_spot()` apply the same `match_signup_eligibility()` they always
did: active membership, accepted guidelines, match open, signup deadline, and
capacity.

**There is no reserved seat.** Somebody who cancelled and comes back to a full
match joins the waitlist behind whoever took their place. Holding a spot open
for a canceller would penalise the player who legitimately claimed it.

### C. Administrator re-entry obeys the administrator rules

`add_member_to_match()` still refuses to exceed capacity, still requires an
override reason after the signup deadline, and still refuses a member who is
not active. Re-entry adds no new administrator power.

### D. One row, always

Re-entry **reuses the existing `match_signups` row** — guaranteed by the unique
constraint on `(match_id, membership_id)` and by every writer using
`insert … on conflict do update`. A second signup row is never created, which is
what keeps capacity accounting correct no matter how many times somebody churns.

### E. `confirmed_at` is never cleared

`match_signups.confirmed_at` is the durable "was ever confirmed" marker, set by
trigger the first time a row becomes confirmed by any route and **never cleared
by anything** — not by cancellation, not by re-entry, not by an administrator
removing somebody.

It is first-wins: a player confirmed, dropped and re-confirmed keeps the instant
they were first counted on. This is what makes the attendance register
answerable after the fact (`match_attendance_population()`), and it is why
somebody who was only ever waitlisted never acquires one — the marker means
"was ever confirmed", not "was ever in this match".

### F. Current state may be cleared; history may not

The trigger clears `canceled_at` and `cancellation_reason` when a row leaves a
cancelled state. Those two columns describe the row's **current** state, and the
check constraint says so.

**Everything durable survives**, because none of it lives on that row:

| Record | Where | Survives re-entry |
|---|---|---|
| That a cancellation happened, and whether it was late | `audit_events` (`signup.canceled`, `late: true/false`) | yes — append-only |
| What the player was told | `notifications` (`cancellation_receipt`) | yes |
| That the administrator was alerted to a late withdrawal | `notifications` (`late_cancellation`) | yes |
| That they were ever confirmed | `match_signups.confirmed_at` | yes |
| Their attendance outcome | `attendance_records` + `audit_events` | yes |

So a player who withdrew late and rejoined has a clean *current* signup and a
permanent record of the late withdrawal. Both are true at once, which is the
point: the roster must reflect who is playing on Saturday, and the history must
reflect what actually happened.

### Attendance follows current state, deliberately

Because the live row is confirmed again, `record_attendance()` offers
*Attended*. That is correct — the player ultimately played. Had the earlier
cancellation continued to govern the row, the outcome validation would have
refused the one outcome that matches reality.

## Consequences

- A canceller who rejoins and cancels again produces **two** audit events and
  **two** receipts, distinguishable by their classification.
- A member with a long history of late withdrawals is not throttled by the
  product. The administrator sees the facts on the roster workspace and decides.
- Nothing recovers cancellations from **before** this migration: no historical
  row has a `confirmed_at` unless it was confirmed at the time, because the
  information was never recorded.

## Alternatives rejected

**Block re-entry after a late withdrawal.** An automatic sanction with no
approved policy behind it, and it would make the product decide something 04 §1
reserves for the administrator.

**Create a new signup row per attempt.** Would break capacity counting, the
unique constraint, and the one-row-per-player-per-match model every projection
assumes — for a history the audit trail already keeps.

**Leave `canceled_at` set on a re-confirmed row.** Rejected by the check
constraint, and it would make "is this player currently cancelled?" unanswerable
from the row.

**Restore their original waitlist position or hold their spot.** Would penalise
whoever legitimately took the place, and no document grants a canceller
priority.

## Verification

`tests/db/signup-reentry.test.ts` — 26 tests, one section per lettered point
above, including the five named scenarios: late-cancel-then-rejoin; on-time
cancel, rejoin, and attend; two cancellations with both auditable; a
waitlist-only member never acquiring `confirmed_at`; and duplicate re-entry
presses leaving one row and correct capacity.

`tests/db/cancellation.test.ts` covers the four routes back in.
`e2e/specs/phase7-attendance.spec.ts` covers it through the browser.

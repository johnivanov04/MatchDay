# The RMVFC pilot

How to set the pilot league up in the product as built, what to watch during it,
and — most importantly — the one rule the pilot must not quietly break.

The roadmap (03 §10) defines the plan and the success gate. This document is the
part that only makes sense once the software exists: which screen does what,
which settings match the club's guidelines, and where the product deliberately
stops.

---

## 1. Setting the league up

Everything here is done through the app by the administrator. There is no
importer and no seeding script for production — `supabase/seed.sql` is
development fixture data and must never touch a real project.

**League** — *Create a league*. New leagues are private and there is no
visibility control on the creation form, because 01 §6 makes private the only
correct default. Switch it later in *Settings* only if the club wants to be
discoverable.

**Settings**, matching 01 §7:

| Setting | Value | Why |
|---|---|---|
| Default capacity | 22 | 11 v 11 |
| Minimum to play | the club's own figure | Drives the "needs players / on track" label, nothing else |
| Selection | Administrator approval | 03 §10 step 3 |
| Waitlist | Administrator-controlled | Same. Nobody is promoted without the administrator |
| Priority window | 24 hours | Resident priority. Runs from publication, and is recorded per signup as `priority_qualified` |
| Cancellation cutoff | noon the day before | Everything after it is classified `withdrawn_late` |
| Teams | 2 | Changeable per match |
| Gender / goalkeeper fields | leave off unless the club asks | They are opt-in per league and absent from every projection when off |

**Guidelines** — paste the club's rules under *Guidelines → Manage*. Publishing
a version that requires acceptance blocks signup until each member accepts it,
so publish it **before** inviting anybody, or the first match will stall.

**Templates** — one for Monday, one for Wednesday. A template carries the times,
location and deadlines so creating a match is a two-field job rather than a
twelve-field one.

**Members** — *Members → Add a member* takes an email address of somebody who
already has a Matchday account; an invitation link is the route for everybody
else. Both are on the same screen.

---

## 2. The rehearsal match

Run this before any real match. It is where configuration mistakes surface
cheaply.

1. Create a match from the Monday template, dated a few days out. It starts as a
   **draft** — invisible to members.
2. Publish it. Every active member is notified.
3. Have three or four people request a spot; confirm some and waitlist others
   from *Manage roster*.
4. **Publish the roster.** Until this, decisions are private and nobody has been
   told anything.
5. Build and publish teams from *Manage teams*. Randomize is **count-only** and
   says so — it does not claim to balance anything, because the MVP stores no
   skill data to balance with.
6. Have somebody cancel. Check the administrator gets the alert, and that a
   cancellation after the cutoff is labelled a late withdrawal and **not** a
   no-show.
7. After the match ends, open **Attendance**, record an outcome for everybody,
   and press *Complete match*.

Step 7 is the one nobody will have seen before. It is worth doing once with the
administrator watching.

---

## 3. Recording attendance

The register opens **once the match has finished** — the link is on the match
page from the moment it is published, and the page explains when to come back.

It lists **everybody who was ever confirmed**, including people who later
withdrew, because they still need an outcome. Somebody who was only ever on the
waitlist is not listed at all.

Five outcomes (02 §16):

| Outcome | For |
|---|---|
| Attended | Played |
| Did not attend | Was expected and did not appear |
| Excused absence | Could not make it, for a reason the administrator accepts |
| Cancelled on time | Withdrew before the cutoff |
| Cancelled late | Withdrew after it |

The interface offers only the outcomes that fit how the player left: somebody
who withdrew cannot be marked *Attended* or *Did not attend*, and somebody who
never withdrew cannot be marked as having cancelled. The database enforces this
independently.

**Corrections are expected, not exceptional.** Change an outcome any time, even
after completing the match. Each correction bumps a revision, tells the player
again, and leaves the previous value in `audit_events` permanently.

**The note is administrator-only.** It is never shown to the player, never sent
in a notification, never pushed, and never written to a log.

**Completing a match** requires an outcome for everybody. That is deliberate:
without it, "completed" would mean only that somebody pressed a button, and the
register would stay quietly incomplete.

---

## 4. The rule the pilot must not break

> **A no-show never disciplines anybody automatically.**

Not after two, not after five, not after twenty. Recording a no-show does
exactly two things: it stores the fact, and it tells the player it was recorded.

It does **not** suspend, remove, block signup, lower waitlist priority, reject a
future request, change a team assignment, or feed a hidden score. There is no
such score anywhere — `tests/db/attendance.test.ts` sweeps
`information_schema.columns` and fails if a column named like one ever appears.

What the product does instead is **show the administrator the facts**. On the
roster workspace, beside a name: *"Did not attend 3 of 8 recorded matches, most
recently 14 Sep"*. No badge, no colour scale, no tier, no ratio, no ranking —
because each of those is the product deciding where a threshold lies, and no
approved document defines one. 04 §1 settles it: the product warns, the
administrator decides.

If the pilot produces pressure to automate this, that is a product decision for
after the pilot, made deliberately and written down — not a quiet change to a
threshold.

---

## 5. Suspending or removing somebody

*Members* → change the status. A reason is required for suspension and removal,
and only administrators can ever read it.

**It cascades to future matches.** Suspending or removing somebody releases
every spot they hold in matches that have not been played, closes the gap they
leave in the waitlist, promotes a replacement where the league is on automatic,
and republishes the teams without them.

Two things it deliberately does not do:

- **It never records a player cancellation.** The signup becomes *not selected*,
  not *cancelled*, and no receipt is sent. The player did not withdraw; an
  administrator decided. Recording it the other way would put words in their
  mouth and corrupt the late-cancellation classification.
- **It never touches a match already played.** Their attendance history is
  history.

"Suspend until" is a note of intent. **Nothing expires it** — there is no job
that reactivates anybody, because that would mean somebody regaining access with
no administrator deciding it. Reactivation is always deliberate.

The sole administrator cannot suspend or remove themselves. Transfer
administration first.

---

## 6. Phones

The pilot happens on phones, so tell players two things:

1. **iPhone users must add the app to the home screen** (Share → Add to Home
   Screen) *before* notifications can work at all. iOS allows Web Push only for
   installed sites. Nothing in the interface can work around this.
2. Then turn notifications on in *Settings → Devices*. Permission is never
   requested on page load — it is always a deliberate tap, because a browser
   that has been refused once does not ask again.

Push carries match publication, changes, cancellations, waitlist promotions,
roster and team publication, and reminders. It deliberately does **not** carry
attendance: that renders on a lock screen anyone can read, and it is never
urgent. Players find it in the app.

---

## 7. What to watch

Against the roadmap's success gate (03 §10):

| Gate | How to check |
|---|---|
| App is the source of truth for four matches | No side-channel WhatsApp roster. Ask the administrator directly — they will know |
| Most players complete signup unassisted | Count how many needed a message explaining it |
| One cancellation and promotion succeeds | The database records it; `notifications` shows what each person was told |
| Teams published through the app | `matches.teams_published_at` is not null |
| No critical authorization or capacity defect | `action.failed` in the logs, and any report of somebody seeing another league's data |

Two failure modes worth watching for specifically, because they are the ones
this product could plausibly get wrong:

- **A match seating more players than its capacity.** Every path takes a match
  row lock; 33 concurrency tests exist to keep that true. One report of it is
  serious.
- **Anybody seeing a name, phone number, or attendance outcome that is not their
  own.** The privacy model is row-level and enforced in the database, but the
  pilot is the first time real people probe it.

---

## 8. Questions to ask afterwards

The roadmap asks for the administrator and five players. Worth asking, because
the answers change what gets built next rather than merely confirming it worked:

**Administrator** — Did the no-show *warning* tell you enough to decide, or did
you want the product to decide for you? What did you do outside the app, and
why? Was publishing the roster separately from creating the match useful, or an
extra step?

**Players** — Did you know whether you were in? When you cancelled, were you
confident the club knew? Did you ever see your own attendance, and did it match
what you thought happened?

The first administrator question is the important one. The answer determines
whether §4 stays a principle or becomes a product decision to revisit
deliberately.

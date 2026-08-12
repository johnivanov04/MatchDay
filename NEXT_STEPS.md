# Next steps

Phases 1, 2, 3, 3B, 4 and 5 are complete. This document covers what to verify by
hand — including the parts that cannot be tested automatically — and what Phase
6 should start with.

---

## 1. Local setup

```bash
npx supabase start        # if not already running
npm run db:reset          # 40 migrations + seed
npm run dev
```

Sign-in emails are captured at <http://127.0.0.1:54324> and never leave the
machine. Seeded accounts all use the reserved `.test` TLD.

For Web Push you also need VAPID keys:

```bash
npx web-push generate-vapid-keys
```

Put them in `.env.local`:

```
NEXT_PUBLIC_VAPID_PUBLIC_KEY=<public key>
VAPID_PRIVATE_KEY=<private key>
VAPID_SUBJECT=mailto:you@example.com
```

Without them the app runs normally and push simply reports itself as not
configured — the in-app inbox is unaffected, which is the whole point of the
layering.

---

## 1b. End-to-end tests

```bash
npm run test:e2e:fresh     # THE canonical command: resets the database, runs all 149
npm run test:e2e           # attach to an already-clean stack
npm run test:e2e:parallel  # three workers — one file at a time only, see §3
npm run test:e2e:headed    # watch it happen, for debugging
npm run test:e2e:ui        # Playwright's interactive runner
```

**149 tests across twelve spec files** cover Phases 1–7 through a real browser,
against the real Supabase stack: real Row Level Security, real server actions,
real database functions. Nothing is mocked and the application contains no
test-only route — the suite mints a genuine Supabase session through the Auth
API and installs the cookie, exactly as a magic link would.

`npm run test:e2e:fresh` finishes **149/149** in about two and a half minutes.
It runs one Playwright worker, deliberately; §3 explains why, and why that was
verified as a stack limit rather than assumed to be one.

For a faster inner loop, start the server once and let Playwright attach to it:

```bash
npm run build && npx next start --port 3100
npm run test:e2e -- e2e/specs/phase4-signup.spec.ts
```

---

## 2. Manual verification walkthrough

### Guidelines and eligibility

1. Sign in as `admin.rmvfc@matchday.test` → **Guidelines** → *Manage guideline
   versions*. The seeded `2026-development` version is published and requires
   acceptance; confirm you cannot edit its text.
2. Write a new draft, tick *members must accept*, and publish it.
3. Sign in as `player.rmvfc@matchday.test` → **Guidelines**. Confirm the
   acceptance box is **unticked**, that submitting without ticking is refused,
   and that accepting then shows "You are up to date".
4. Sign in as `player.multi@matchday.test`, who belongs to both leagues.
   Confirm RMVFC asks for acceptance while Weeknight 5v5 does not — the same
   person, two different answers, which is the tenancy property.

### Templates and matches

5. As the RMVFC administrator → **Matches** → *Templates*. Two seeded templates
   exist. Edit one and confirm the seeded match created from it is unchanged.
6. *Create a match*, pick a template, confirm every field pre-fills and stays
   editable. Save; it appears as **Draft**.
7. Sign in as a member and confirm the draft is **not** visible.
8. As the administrator, open the draft and *Publish to members*. Press publish
   again and confirm nothing changes and no second notification appears.
9. Confirm the member now sees the match, and that the detail page shows a
   "signup arrives in the next phase" state rather than a button that does
   nothing.

### Notifications

10. As the member, check the **Inbox** badge in the header and the notification
    for the published match. Follow its link, then *Mark as read*.
11. As the administrator, remove that member (**Members** → status *Removed*).
    Sign back in as them and follow the same notification link: it must land on
    the dashboard with a notice, not on the match, and not on an error page.

### Web Push — requires a real device or browser

This is the part no automated test covers, because nothing in the suites makes
a network call.

12. Open **Alerts** (`/settings/devices`) in Chrome or Firefox over HTTPS or
    `localhost`. Confirm the permission prompt appears **only** when you press
    *Enable phone notifications*, never on page load.
13. Deny permission once and confirm the page explains that alerts still arrive
    in the app.
14. Grant permission, confirm the device is listed, then publish a match from
    another account and confirm the notification appears on the operating
    system — and that its text carries only the league and match name and time.
15. Click the notification and confirm it opens the match page, reusing an
    existing tab if one is open.
16. Turn the device off, publish again, and confirm no push arrives but the
    in-app notification still does.
17. **iOS specifically:** add Matchday to the home screen first. iOS only
    delivers web notifications to installed apps, so testing in Safari alone
    will look broken when it is not.
18. Run `next dev --experimental-https` if your browser refuses to register the
    service worker over plain HTTP.

### Signup, rosters and waitlists (Phase 4)

Seeded matches: **Thursday 5v5** (Weeknight 5v5) is first-come, capacity 10.
**Monday night 11v11** (RMVFC) is administrator-approval, capacity 22. To make a
waitlist form without inventing twenty accounts, edit the match and set capacity
to 2.

**First-come**

19. Sign in as `player.multi@matchday.test` → Weeknight 5v5 → *Thursday 5v5* →
    **Join match**. Confirm the badge reads *You are playing* and that you
    appear on the confirmed roster marked "(you)".
20. Fill the remaining spot from another account, then join from a third.
    Confirm the third sees *Waitlisted — position 1*.
21. As the waitlisted player, confirm the page shows the confirmed roster in
    full, the waitlist **size**, and no other player's position or name in a
    queue.
22. Press **Join match** again from each account. Nothing changes and no second
    notification arrives.

**Administrator approval**

23. As `player.multi@matchday.test` → RMVFC → *Monday night 11v11* → **Request a
    spot**. Confirm it says *Selection pending* and states explicitly that this
    is **not** a confirmed spot.
24. As `admin.rmvfc@matchday.test`, open the match → **Manage roster**. The
    request appears under *Requested a spot* with its response time.
25. **Confirm** that player. Move a second to the **waitlist**. Mark a third
    **not selected**.
26. With two or more waitlisted, use the ↑/↓ buttons and *Save this order*.
    Confirm the numbering is 1..N with no gaps.
27. **Add a member** — the picker lists memberships only, never email
    addresses. Add one to the confirmed roster.
28. Press **Publish roster**. Confirm each affected player receives exactly one
    notification saying what happened to *them*.
29. Press **Publish roster** again. Confirm no new notifications and the roster
    revision does not move.
30. Change one decision, publish again, and confirm only that player hears the
    new outcome while the others get "the roster changed, your place is
    unchanged".

**Privacy**

31. As a waitlisted player, confirm you cannot see the full waitlist, anybody
    else's position, or the administrator workspace at
    `/leagues/rmv-football-club/matches/<id>/roster` — it redirects to the
    dashboard rather than erroring.
32. As `admin.fives@matchday.test` (a different league's administrator), open
    that same roster URL. It must redirect identically.

**Boundaries**

33. As `player.rmvfc@matchday.test`, who has not accepted the required RMVFC
    guidelines, confirm the match page explains that and offers no signup
    control.
34. Edit a match so signup has already closed, then confirm a member sees
    *Signup for this match has closed* rather than a button.
35. Cancel a match and confirm it accepts no responses.
36. As a **confirmed** player, confirm there is no *Cancel my spot* control —
    only a note saying it is not available yet. That is Phase 5, and nothing
    here fakes it.

### Cancellation, promotion and reminders (Phase 5)

Set up: edit **Thursday 5v5** (Weeknight 5v5, first-come, *automatic*
promotion) and set capacity to 2. RMVFC's **Monday night 11v11** is
*administrator-controlled*, which is the other half of these checks.

**On-time cancellation**

37. Sign in as a confirmed player → open the match. The signup panel shows the
    cancellation cutoff.
38. Press **Cancel my spot**. Before confirming, the panel says cancelling now
    is **on time** and names the cutoff.
39. Confirm. Status becomes *Cancelled*, the confirmed count drops, and a
    cancellation receipt appears in the inbox.

**Late cancellation**

40. As the administrator, edit the match so the cancellation cutoff has already
    passed (set the cutoff hours to 0 and the kickoff to today).
41. As a confirmed player, press **Cancel my spot**. The panel warns in amber
    that this is a **late cancellation** and that the administrator will be told.
42. Confirm. The player sees *Withdrew late*. Check the wording says nothing
    about a no-show — that is Phase 7's judgement, not this one's.
43. Sign in as the administrator and confirm a *Late withdrawal* notification
    arrived, and that it does **not** contain the reason the player typed.

**Automatic promotion**

44. Put two players on the waitlist behind a full first-come match.
45. Have a confirmed player cancel.
46. Waitlist #1 is now confirmed; the old #2 is now #1. The confirmed count is
    unchanged and still within capacity.
47. Sign in as the promoted player and confirm the *You are in* notification.

**Administrator-controlled replacement**

48. On the RMVFC match, have a confirmed player cancel.
49. Confirm **nobody** was promoted automatically.
50. As the administrator, open **Manage roster**. The *Open spots* panel shows
    the vacancy and a recommended player.
51. Press **Promote to the roster**. The candidate is confirmed and the waitlist
    compacts.
52. Choose somebody other than the recommendation and confirm a reason is
    required before the form will submit.

**Waitlist withdrawal**

53. As waitlist #2, press **Leave the waitlist**. The panel shows your own
    position first.
54. Confirm: no capacity changes, nobody is promoted, and the remaining
    positions renumber with no gap.

**Notification centre**

55. On **Notifications**, use *Mark as read* / *Mark as unread* and watch the
    header count follow.
56. **Archive** a notification: it leaves the list and the unread count, and its
    read state is unchanged.
57. Sign in as another account and confirm you cannot see or mutate the first
    account's notifications.

**Reminders**

58. Give a match a reminder offset and publish it:

    ```sql
    update public.matches
       set reminder_offsets = array[interval '2 hours']
     where id = '<match id>';
    select public.materialize_match_reminders('<match id>');
    update public.match_reminders set due_at = now() - interval '1 minute'
     where match_id = '<match id>';
    ```

59. Run the generator and confirm exactly one reminder per confirmed player:

    ```bash
    npm run reminders:run
    ```

60. Run it again. It reports `Claimed 0` and no duplicate notification appears.

> **Production note.** `npm run reminders:run` and `POST /api/cron/reminders`
> are the operation, not a schedule. **Nothing in this repository runs them on a
> cadence.** Production must call the route every few minutes with
> `Authorization: Bearer $CRON_SECRET` — a Vercel Cron entry or a Supabase
> `pg_cron` job invoking `generate_due_reminders()` both work. Until that is
> configured, reminders never go out.

### Attendance, completion and membership status (Phase 7)

Attendance opens only once a match has ended, so give yourself a finished match:

```sql
-- Shift a seated match into the past. Every timestamp moves together, so the
-- ordering constraints still hold and any earlier cancellation keeps its
-- on-time / late classification.
update public.matches
   set match_date = match_date - interval '2 days',
       arrival_at = arrival_at - interval '2 days',
       kickoff_at = kickoff_at - interval '2 days',
       end_at = end_at - interval '2 days',
       signup_closes_at = signup_closes_at - interval '2 days',
       cancellation_cutoff_at = cancellation_cutoff_at - interval '2 days'
 where id = '<match id>';
```

1. **The register.** Match → *Attendance*. Everybody who was ever confirmed is
   listed, including anybody who withdrew. Somebody who was only ever on the
   waitlist is not — their signup status is `canceled` exactly like a confirmed
   player who cancelled, which is why the population is defined by
   `match_signups.confirmed_at` and not by status.
2. **The outcomes offered depend on how the player left.** A player who withdrew
   is not offered *Attended* or *Did not attend*; one who never withdrew is not
   offered either cancellation outcome. The database refuses both independently
   of the interface.
3. **Corrections.** Change an outcome and press *Update*. The row shows
   "corrected 1×", the player gets a second notification, and the previous value
   is in `audit_events` forever:

   ```sql
   select action, before_data ->> 'outcome' as was, after_data ->> 'outcome' as now
     from public.audit_events where entity_type = 'attendance' order by created_at;
   ```

   `had_note` appears there instead of the note itself — the note is
   administrator-only and never leaves the table.
4. **Completion** requires an outcome for everybody. With one missing, *Complete
   match* refuses and says how many are outstanding. Corrections still work
   afterwards.
5. **The player's view.** Sign in as that player: the match page shows their own
   outcome and the league's match list shows their history. Neither carries the
   note, and neither can be asked about anybody else — `my_attendance()` takes
   no membership parameter.
6. **No-show context.** Record a no-show, then open the roster of a *future*
   match that player has joined. The count appears beside their name as a
   sentence. Confirm what did **not** happen: they are still `confirmed`, still
   `active`, and still in their original waitlist position.
7. **Membership status.** *Members* → suspend somebody with a reason. Their
   spots in future matches are released as `not_selected` (never `canceled`, and
   with no receipt sent), the waitlist closes up, and published teams get a new
   revision without them. A match already played is untouched. Try to suspend
   yourself as the sole administrator — it is refused with
   `ADMIN_TRANSFER_INVALID`.

> **Push note.** Attendance notifications are deliberately **not** push-eligible.
> They appear in the inbox and nowhere else — a payload renders on a lock screen,
> and "You are recorded as not having attended" does not belong there.

### The polish surfaces

- **Loading** — throttle the network in devtools and navigate; a skeleton
  appears with a `role="status"` announcement rather than a blank page.
- **Error** — the boundary shows a reference digest and a *Try again*, never the
  thrown message.
- **Not found** — visit any nonsense path. Note that an *unauthorized* league or
  match is **not** a 404: it redirects to the dashboard, so that "does not
  exist" and "is not yours" are indistinguishable.
- **Health** — `curl -i http://localhost:3000/api/health`. It reports status and
  database reachability and deliberately nothing else.

---

### Confirm the boundaries directly

```bash
# Push credentials must be unreadable, even by their owner.
#   → expects: permission denied for table push_subscriptions
# Draft matches must be invisible to members.
#   → expects: only published rows
```

Both are asserted by `tests/db/web-push.test.ts` and `tests/db/matches.test.ts`;
run `npm run test:db` for the authoritative answer.

---

## 3. The end-to-end suite

`npm run test:e2e:fresh` resets the database and runs all **149 specs**. It
finishes **149/149**, reproducibly — verified over three consecutive fresh runs
at ~2.4 minutes each.

### Why it runs one worker

`playwright.config.ts` pins `workers: 1`. Not because the specs interfere —
`fullyParallel` is still true and every spec builds its own league, members and
matches — but because the local Supabase container cannot keep up with more.

GoTrue runs without connection pooling and the application validates the session
on every render, so each extra worker multiplies both token minting and
per-render validation until the Docker bridge runs out of ephemeral ports. The
symptoms did not look related to each other, which is what made this worth
pinning down rather than retrying away:

- `admin/generate_link` answering 500, so a sign-in fails outright;
- a render arriving at 11s against an assertion's 10s budget, so a correct page
  "does not contain" text that is on its way;
- a whole test exceeding its timeout waiting for that page.

Three workers cost about twenty failures a run, two cost about four, one costs
none. **It was verified as infrastructure rather than assumed to be**: across a
failing run the Next.js server logged no 5xx of its own, and
`withTransientRetry` in `e2e/support/auth.ts` wraps only the two GoTrue admin
endpoints — it cannot see, let alone retry, an application response. An
application 500 still fails a test immediately, as it should.

The retry budget was deliberately wound back down afterwards (five attempts,
~1.5s, 5xx only). A budget wide enough to paper over the pressure is also wide
enough to hide a genuinely slow path.

`npm run test:e2e:parallel` runs three workers for a quick loop on a single
file. It is not the canonical command and will produce exactly the failures
described above if pointed at the whole suite.

CI runs `npm run test:e2e`, which takes the same one-worker configuration.

---

## 4. Running it for real

Two documents, written for an operator rather than a developer:

- [`docs/operations/production.md`](docs/operations/production.md) — environment
  variables and which ones are secret, migrations, `/api/health`, the scheduler
  reminders require, Web Push and the iOS home-screen constraint, what the logs
  may never contain, and what this MVP does not have.
- [`docs/operations/pilot.md`](docs/operations/pilot.md) — the RMVFC league
  settings that match 01 §7, the rehearsal match, recording attendance, and the
  no-automatic-discipline rule the pilot must not break.

---

## 5. If there is a Phase 8

The MVP is complete at Phase 7. Nothing below is required, and none of it should
be started without a decision written down first.

**What the pilot will most likely push on.** The administrator will be asked
whether the no-show *warning* was enough or whether they wanted the product to
decide (see `docs/operations/pilot.md` §8). If the answer is "decide for me",
that is a product decision about disciplinary policy — thresholds, appeals, who
is accountable for the outcome — and not a code change. 04 §1 currently settles
it the other way, deliberately.

**Genuine gaps a real deployment will hit**, in rough order of how soon:

- **No data-retention or deletion path.** Removing a member's data is a manual
  database operation today. A real deployment in most jurisdictions needs an
  answer to this.
- **`teams_published` is a lifecycle state nothing can reach.** Phase 6 settled
  that team publication is metadata; the enum value is a name without a state.
  Either implement it or remove it, rather than leaving it looking implemented.
- **A single administrator per league** (01 §8) makes every league one lost
  password away from being unmanageable. The deferred single-active-admin
  constraint is what a second role would have to work around.
- **Historical rows have no `confirmed_at`.** Anybody confirmed and cancelled
  *before* Phase 7 cannot appear in that match's register — the information was
  never recorded. Only matters if there is production data predating the
  migration.
- **Push has no batching.** The fan-out is a loop over subscriptions; it is fine
  for a 22-player league and would not be for a thousand.

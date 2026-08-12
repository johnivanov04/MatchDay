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
npm run test:e2e:fresh     # resets the database, then runs the whole suite
npm run test:e2e           # attach to an already-clean stack
npm run test:e2e:headed    # watch it happen, for debugging
npm run test:e2e:ui        # Playwright's interactive runner
```

93 tests across six spec files cover Phases 1–5 through a real browser, against
the real Supabase stack: real Row Level Security, real server actions, real
database functions. Nothing is mocked and the application contains no test-only
route — the suite mints a genuine Supabase session through the Auth API and
installs the cookie, exactly as a magic link would.

**Run the suite from a freshly reset stack.** GoTrue opens a PostgreSQL
connection per request and does not pool, and the application validates the
session on every render, so across several full runs on one container it
exhausts the Docker bridge's ephemeral ports and starts answering 5xx. From a
clean stack the suite passes 93/93; on the second consecutive run without a
reset roughly ten tests fail on that. It is local stack capacity, not an
application fault, and CI is unaffected because each job starts its own stack.
`npm run test:e2e:fresh` is the reliable local command.

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

## 3. Review before Phase 5

Worth a human read, in this order:

1. `supabase/migrations/20260805030900_revoke_public_function_execute.sql` — a
   real vulnerability found by the Phase 3 suite. Phase 2's
   `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE … FROM PUBLIC` recorded nothing,
   so every Phase 3 function shipped PUBLIC-executable.
2. `supabase/migrations/20260805030100_guideline_functions.sql` — the
   eligibility predicate Phase 4 will depend on, and why it answers only about
   the caller.
3. `supabase/migrations/20260805030300_match_functions.sql` — why the timezone
   conversion lives in the database.
4. `src/lib/push/dispatch.ts` — why push failures are swallowed.

Judgement calls to confirm or overturn:

- **The acting administrator is excluded from `match_published` fanout.** They
  just published it. Reversing this is a one-line change in
  `20260805030700_notification_integration.sql`.
- **"Currently required" is the single newest published, unarchived, effective
  version.** Requiring every historical version would make a late joiner
  permanently ineligible.
- **Administrator notes live in `match_admin_notes`, not on the match row**,
  for the same reason as `league_membership_admin_notes`: RLS filters rows, not
  columns, and members must read the match.
- **`match_lifecycle_status` declares all six states** while a trigger permits
  only the three Phase 3 implements. Phase 4 extends the trigger, not the enum.

---

## 4. Recommended first Phase 6 task

**`match_teams` and `match_team_assignments` — the tables, their constraints,
and an `assign_player_to_team()` that cannot place somebody twice — before any
team-builder UI.**

The seams Phase 5 leaves for it:

- `match_lifecycle_status` already declares `teams_published`, and
  `matches_guard_status_transition()` already allowlists
  `open → roster_finalized` while refusing `roster_finalized → teams_published`
  with a comment saying Phase 6 adds it. Extend the trigger, not the enum.
- 02 §17 names a **team revision** as distinct from the roster revision, exactly
  as `roster_revision` is distinct from `revision`. Add a third counter rather
  than overloading either; `advance_roster_revision_if_published()` is the
  pattern to copy.
- Only confirmed players may be assigned, and `signup_consumes_capacity()`
  already defines who those are. A cancellation that releases a spot after teams
  are published will need to drop that player's assignment — the one genuinely
  new interaction between Phase 5 and Phase 6, and worth designing before the
  UI.
- `notification_type` needs a `teams_published` value, in its own migration for
  the usual enum reason.
- `leagues.position_labels`, `gender_field_enabled` and `goalkeeper_field_enabled`
  already gate what the builder may display, and `match_roster_admin()` already
  honours them.

Randomization is count-only (04 §3) and must not claim balance. Draft teams stay
invisible to players until publication, which is the same `published_at`-style
visibility rule `matches_select_member` already demonstrates.

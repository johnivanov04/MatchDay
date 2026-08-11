# Next steps

Phases 1, 2, 3, 3B and 4 are complete. This document covers what to verify by
hand — including the parts that cannot be tested automatically — and what Phase
5 should start with.

---

## 1. Local setup

```bash
npx supabase start        # if not already running
npm run db:reset          # 35 migrations + seed
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

## 4. Recommended first Phase 5 task

**`cancel_spot(match_id, reason?)` — the transaction that releases a confirmed
spot, classifies the cancellation against the cutoff, and promotes at most one
waitlisted player.**

Phase 4 left a clean seam for it on purpose:

- `signup_status` already declares `canceled` and `withdrawn_late`, and
  `match_signups_guard_status()` refuses both. Phase 5 relaxes that trigger; no
  migration touches a populated table.
- `canceled_at` and `cancellation_reason` already exist, constrained so they can
  only ever be set together with a cancellation status.
- `signup_consumes_capacity()` already excludes both, so a canceled player stops
  occupying a slot the moment the status changes — no counting code moves.
- `compact_waitlist()` already renumbers 1..N under the deferred constraint, so
  promotion is "confirm the person at position 1, then compact".
- Every capacity-touching function already takes `select ... for update` on the
  match row first. Promotion must take the same lock, in the same place, or the
  serialization guarantee is lost.

The one genuinely new decision is **automatic versus administrator-controlled
promotion**. `matches.waitlist_mode` is stored and honoured nowhere in Phase 4
except as configuration; F-09 requires automatic mode to promote inside the
transaction that releases the spot, and administrator-controlled mode to notify
with a recommendation and promote nothing. Both need the "a single opened spot
cannot promote two players" test that PRD §13 makes a success metric — write it
with real concurrent connections, as `tests/db/signup-concurrency.test.ts`
already does.

`mark_unavailable()` currently raises `SIGNUP_CANCELLATION_UNAVAILABLE` for a
confirmed player. That refusal is the marker for where Phase 5 begins.

**Then**, in order: on-time versus late classification and the administrator
alert, the cancellation receipt and promotion notifications, and reminder
scheduling — reusing the notification fanout Phase 3 provides and the
`reminder_offsets` metadata already stored on templates.

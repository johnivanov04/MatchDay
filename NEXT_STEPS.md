# Next steps

Phases 1, 2 and 3 are complete. This document covers what to verify by hand —
including the parts that cannot be tested automatically — and what Phase 4
should start with.

---

## 1. Local setup

```bash
npx supabase start        # if not already running
npm run db:reset          # 29 migrations + seed
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

## 3. Review before Phase 4

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

## 4. Recommended first Phase 4 task

**`match_signups` — the table, its constraints, and a transactional
`join_match()` that claims capacity safely — before any roster or waitlist UI.**

It is the right next task for three reasons:

- **Everything else in Phase 4 is a read of it.** Rosters, waitlist order,
  promotion and the derived `needs_players`/`enough_players`/`full` labels are
  all projections of signup rows. Building any of them first means building
  them twice.
- **It is the one place concurrency actually bites.** PRD §13 makes "no
  confirmed spot is duplicated under concurrent requests" a success metric.
  Capacity has to be claimed inside a transaction or a protected function —
  `SELECT … FOR UPDATE` on the match row, or a unique partial index over
  confirmed positions — and that decision shapes the whole phase.
- **The two Phase 3 seams are already waiting for it.**
  `has_accepted_required_guidelines(league_id)` is the eligibility gate, and
  `deriveMatchParticipationState(counts)` already accepts counts and returns
  `signup_not_open` only when passed `null`. Phase 4 supplies real counts and
  the labels start working with no change to either.

Suggested shape:

```sql
create table public.match_signups (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null,
  match_id uuid not null,
  membership_id uuid not null,
  status public.signup_status not null,      -- 02 §3 lists seven values
  responded_at timestamptz not null default now(),
  priority_qualified boolean,
  waitlist_position integer,
  ...
  constraint match_signups_match_fk
    foreign key (match_id, league_id) references public.matches (id, league_id),
  constraint match_signups_membership_fk
    foreign key (membership_id, league_id)
    references public.league_memberships (id, league_id)
);
-- unique (match_id, membership_id)          -- one signup per player per match
-- unique (match_id, waitlist_position) where status = 'waitlisted'
```

with `join_match(match_id)` checking, in one transaction: active membership,
`has_accepted_required_guidelines`, match status `open`, signup deadline, and
then capacity — confirming or waitlisting accordingly. Tests should include a
genuine concurrency case: several sessions racing for the final spot, asserting
exactly one confirmation.

**Then**, in order: administrator-approved selection and the roster workspace,
ordered waitlists, and roster publication — reusing the notification fanout
Phase 3 already provides.

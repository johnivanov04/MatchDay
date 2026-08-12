# Running Matchday in production

Everything an operator needs to take this repository from a clean Supabase
project to a deployment a league can use, and nothing that only matters in
development.

Written for the MVP as it stands at the end of Phase 7. Where something is not
built, this says so rather than describing an intention.

---

## 1. What has to exist before the first deploy

| Thing | Why |
|---|---|
| A Supabase project | Postgres, Auth and the Row Level Security every read goes through |
| A host that runs Next.js 16 server-side | Every page is server-rendered and every mutation is a Server Action; a static export cannot run this |
| An SMTP sender configured in Supabase Auth | Sign-in is a magic link. Supabase's built-in sender is rate-limited to a handful of messages an hour and is not usable for a real league |
| A VAPID key pair | Web Push. Generate with `npx web-push generate-vapid-keys` |
| A scheduler | Reminders. See §5 — **nothing in this repository runs on a timer** |

---

## 2. Environment variables

`\.env.example` is the authoritative list; it names every variable and explains
each one. The rules that matter:

- **`NEXT_PUBLIC_*` is inlined into the browser bundle.** Never put a secret
  behind that prefix. The anon key belongs there — Row Level Security is what
  protects the data, not the key's obscurity.
- **`SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security entirely.** It is
  used in exactly one place, `src/lib/supabase/admin.ts`, which is `server-only`
  and reached only by the reminder job. If it ever appears in a client bundle,
  every tenant boundary in the product is gone.
- **`VAPID_PRIVATE_KEY` signs pushes to every subscribed device.** Server-only,
  deliberately unprefixed.
- **`CRON_SECRET` is required for reminders to work at all.** Without it
  `/api/cron/reminders` answers 404 to everybody, so an unprotected trigger
  cannot flush a league's reminders early.

Set them in the host's own encrypted store, not in a file in the repository.

---

## 3. Database

Migrations are plain SQL in `supabase/migrations`, applied in filename order.

```bash
supabase link --project-ref <ref>
supabase db push
```

`supabase/seed.sql` is **development fixture data** — named test accounts, a
sample league, sample matches. It must never run against production.
`supabase db push` does not apply it; `supabase db reset` does. Do not run
`db reset` against a linked production project.

### Verifying the security model after a deploy

The database tests are the real specification of the security model, and they
run against a throwaway PostgreSQL instance rather than your project:

```bash
npm run test:db
```

Two checks in `tests/db/schema.test.ts` are worth knowing about because they
fail closed on a whole class of mistake:

- **every `SECURITY DEFINER` function has a pinned `search_path`** — without it
  a caller can shadow a table name and make the function operate on their own;
- **no function grants `EXECUTE` to `PUBLIC`** — PostgreSQL grants that by
  default on every new function, so it has to be revoked explicitly.

---

## 4. Health checks

`GET /api/health` returns `200 {"status":"ok","database":"ok"}` when the
deployment is serving and can reach Postgres, and `503` when it cannot. It is
unauthenticated and deliberately reports nothing else — no version, no commit,
no environment name, no counts. Point the platform's health check at it.

It runs a real query rather than a connection test, because a pool that connects
but cannot read is exactly the failure a health check exists to catch. The query
goes through the anonymous client, so Row Level Security applies and it can only
ever see what a signed-out visitor could.

---

## 5. Reminders — the one thing that needs a scheduler

**Nothing in this repository runs on a timer.** There is no `setInterval`, no
background worker and no process-local timer, because a timer dies with the
process and fires once per running instance — neither is a scheduler on a
platform that scales to zero.

Match reminders therefore do not go out until an operator configures one:

```jsonc
// vercel.json — every ten minutes
{ "crons": [{ "path": "/api/cron/reminders", "schedule": "*/10 * * * *" }] }
```

Vercel Cron sends `GET`; this route is `POST` and requires
`Authorization: Bearer $CRON_SECRET`. If the platform's scheduler cannot send a
header, drive it from Supabase instead:

```sql
select cron.schedule(
  'matchday-reminders', '*/10 * * * *',
  $$ select public.generate_due_reminders(100); $$
);
```

The SQL route creates the canonical in-app notifications — which is the record
that matters — but **not** the Web Push fan-out, which lives in the application.
Prefer the HTTP route where the platform allows it.

Verify it by hand:

```bash
curl -X POST https://<host>/api/cron/reminders \
  -H "Authorization: Bearer $CRON_SECRET"
# {"claimed":0,"notified":0,"skipped":false}
```

`skipped: true` means no service-role key is configured and nothing ran.

---

## 6. Web Push

Push is a **delivery channel, never the record.** Every notification exists in
the in-app inbox first and is pushed second; a failed push loses nothing.

- Only the types in `PUSH_ELIGIBLE_TYPES` (`src/lib/push/payload.ts`) are ever
  pushed. That set is authoritative — the `push_eligible` flag the SQL writes is
  bookkeeping.
- **Attendance is deliberately not push-eligible.** A payload renders on a lock
  screen where anyone glancing at the phone reads it, and "You are recorded as
  not having attended" is not something to put there. The player is told in the
  inbox.
- **iOS only allows Web Push once the site is on the home screen.** Tell pilot
  players to use Share → Add to Home Screen, then enable notifications from
  Settings → Devices inside the app. Without that step no iPhone gets a push,
  and nothing in the interface can work around it.

### App icons

`public/` carries a 192px and a 512px PNG for the manifest and a 180px
`apple-touch-icon.png` for iOS, all rendered from `public/icon.svg` rather than
drawn separately.

They matter for the **install experience**, not for functionality: iOS does not
render SVG for a home-screen icon and falls back to a screenshot of the page, so
without the PNG somebody installing Matchday gets a blurry crop instead of an
app icon. Web Push is unaffected — what push requires on iOS is that the site is
on the home screen at all, which works with or without a proper icon.

If the SVG changes, regenerate them or they go stale:

```bash
node -e "
const sharp = require('sharp'), fs = require('fs');
const svg = fs.readFileSync('public/icon.svg');
for (const [size, name] of [[192,'icon-192.png'],[512,'icon-512.png'],[180,'apple-touch-icon.png']])
  sharp(svg, { density: 512 }).resize(size, size).png().toFile('public/' + name);
"
```

iOS reads `apple-touch-icon.png` and ignores the manifest's icon list, which is
why that third file exists.

---

## 7. Observability

Server logs are single-line JSON on stdout, which every host collects and
indexes. There is no agent and no vendor.

| Event | Level | Meaning |
|---|---|---|
| `action.refused` | info | A Server Action returned a domain error. Usually the product working — somebody tried to join a full match. Watch the aggregate, not the line |
| `action.failed` | error | Something threw that nobody anticipated. **This is the one to alert on** |

Both come from `actionFailure()`, so every Server Action is covered without each
one having to remember to log.

A render that throws is **not** in that table. The error boundary
(`src/app/(app)/error.tsx`) is a client component and cannot import the
server-only logger, so it emits a plain `[matchday] render failed` line with the
error's `digest` and class. The server side of the same failure is already in
the platform's own request log under that identical digest, which is what to
search on — and it is why the boundary shows the digest to the user.

**What is never logged**, by type rather than by convention (see
`src/lib/observability/log.ts`): names, email addresses, phone numbers, gender,
attendance notes, membership-status or cancellation reasons, administrator
notes, push endpoints, and raw database error messages — any of which can carry
a constraint name, a column value or another tenant's identifier. Identifiers
are logged and are what make a log useful; looking a row up is an authorized act
with its own audit trail.

Alert suggestions: any `action.failed`; `/api/health` non-200 twice in a row;
`claimed: 0` from the reminder route for longer than a match cycle.

---

## 8. Backups and the audit trail

Supabase takes automated backups; check the retention on your plan and match it
to what the league expects.

Two tables are the historical record and are never rewritten in place:

- **`audit_events`** — append-only. Every administrator decision, including the
  before-and-after of every attendance correction and every membership status
  change with its reason.
- **`notifications`** — what each person was actually told, and when.

Restoring to a point in time restores both. Neither is safe to prune without
deciding, explicitly, how much of a league's history it is acceptable to lose.

---

## 9. What this MVP does not have

Stated plainly so nobody deploys expecting it:

- no payments, billing or subscriptions
- no skill ratings, rankings, standings or league tables
- no automatic discipline of any kind (see `docs/operations/pilot.md` §4)
- no SMS, and no routine email beyond the sign-in link
- no native apps — it is a PWA
- no weather integration, tournaments, or guest sponsorship
- no analytics beyond the logs above
- no automated data-retention or deletion job

The last one matters for a real deployment: deleting a member's data is a manual
database operation today.

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
  `/api/cron/reminders` answers 404 to everybody — including Vercel Cron, so
  the declared schedule silently does nothing.
- **`REMINDER_HEARTBEAT_URL` must be set in Production for external heartbeat
  monitoring.** It is a **credential** — anyone holding it can report the
  reminder job healthy — so it is server-only, never logged and never returned
  in a response. Unset (locally, in tests, on Preview) the cron behaves exactly
  as before and logs `heartbeat.skipped`. See §7.
- **`NEXT_PUBLIC_SUPPORT_EMAIL` is optional but strongly recommended before a
  pilot.** Unset, the footer and both error boundaries render nothing, and a
  player who cannot sign in has no route to a human. It is published on purpose
  and is not a secret.

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
goes through the anonymous client and reads `searchable_leagues_public` — the
one object anonymous discovery is allowed to read, so the probe sees only what a
signed-out visitor could.

**It must not be pointed at the `leagues` base table.** `anon` holds no grant on
it, so PostgREST refuses with a 401 before Row Level Security is consulted, and
the endpoint reports a perfectly healthy database as `unreachable`. That is not
hypothetical — it is how this route first shipped to production.

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

### What is in the repository, and what is not

`vercel.json` declares the cron entry:

```json
{ "crons": [{ "path": "/api/cron/reminders", "schedule": "*/10 * * * *" }] }
```

Vercel Cron issues **GET** and injects `Authorization: Bearer $CRON_SECRET`
automatically, which is why the route answers both verbs over the same secret
check. **The entry does nothing until `CRON_SECRET` is set on the project** —
without it the route answers 404 to everybody, including Vercel.

**Still external, and nobody can do it from this repository:**

1. Set `CRON_SECRET` in the Vercel project (Production, and Preview if you want
   it there).
2. Deploy — cron entries are registered at deploy time, not at merge time.
3. Confirm the job appears under **Project → Settings → Cron Jobs** and shows a
   successful invocation.

**Plan limits matter here.** On Hobby, cron jobs run at most **once a day** and
you may have two. A ten-minute cadence needs Pro or above. If you are on Hobby,
either upgrade or use the `pg_cron` route below — a once-a-day reminder is
useless for a match reminder.

### Why ten minutes

A reminder becomes due at `kickoff − offset` and is delivered by the first pass
after that moment, so the cadence is the worst-case lateness. Ten minutes is
comfortably inside a useful margin for offsets measured in hours, and it is 144
invocations a day rather than 1,440. Going faster buys precision nobody needs;
going much slower makes a "2 hours before" reminder arrive at 1h35m.

### The alternative, if the platform cannot send a header

```sql
select cron.schedule(
  'matchday-reminders', '*/10 * * * *',
  $$ select public.generate_due_reminders(100); $$
);
```

This creates the canonical in-app notifications — the record that matters — but
**not** the Web Push fan-out, which lives in the application. Prefer the HTTP
route wherever possible.

### Verify it by hand

```bash
curl -i -X POST https://<host>/api/cron/reminders \
  -H "Authorization: Bearer $CRON_SECRET"
```

| HTTP | Body `status` | Meaning |
|---|---|---|
| 200 | `idle` | Ran, nothing was due. The healthy common case |
| 200 | `worked` | Ran and claimed `claimed` occurrences |
| 500 | `failed` | **The generator errored.** `errorCode` correlates with the log |
| 503 | `skipped` | No service-role key configured; nothing ran and nothing will |
| 404 | — | Wrong secret, or `CRON_SECRET` not set at all |

The status code carries the outcome deliberately, so a platform cron dashboard
or uptime check registers a failure without anybody having to read the body.

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
| `reminder.run` | info | A reminder pass completed, with `claimed` / `notified` / `push_failures`. Emitted on empty passes too, so its **absence** is the signal |
| `reminder.failed` | error | The generator errored; nothing was claimed. **Alert on this** |
| `reminder.skipped` | warn | No service-role key configured, so nothing ran |
| `reminder.push_incomplete` | warn | Notifications committed, push fan-out threw for at least one occurrence |
| `heartbeat.sent` | info | The external heartbeat was pinged, with `kind` = `success` or `failure` |
| `heartbeat.failed` | warn | The monitoring provider was unreachable or answered non-2xx. **Does not affect the cron result** |
| `heartbeat.misconfigured` | warn | `REMINDER_HEARTBEAT_URL` is set but unusable — **monitoring is silently off** |
| `heartbeat.skipped` | info | No heartbeat configured. Expected locally and on Preview; **unexpected in Production** |

Both come from `actionFailure()`, so every Server Action is covered without each
one having to remember to log.

A render that throws is **not** in that table. The error boundary
(`src/app/(app)/error.tsx`) is a client component and cannot import the
server-only logger, so it emits a plain `[matchday] render failed` line with the
error's `digest` and class. The server side of the same failure is already in
the platform's own request log under that identical digest, which is what to
search on — and it is why the boundary shows the digest to the user.

### External heartbeat monitoring

The log events above only help somebody who is reading them. A deployment that
has stopped running crons cannot notice its own silence, so the absence of
`reminder.run` needs an *outside* observer. After every cron invocation the
route pings a Better Stack heartbeat:

| Reminder outcome | HTTP | Heartbeat |
|---|---|---|
| `worked` | 200 | success — base URL |
| `idle` (nothing was due) | 200 | **success** — the heartbeat monitors that the scheduler ran, not whether reminders happened to be due |
| `failed` | 500 | failure — base URL + `/fail` |
| `skipped` (no service-role key) | 503 | failure — reminders are not being delivered, and reporting that as healthy would be the monitoring lying |

Unauthorized requests send nothing at all, so nobody can keep the monitor green
without the cron actually running.

**The heartbeat can never affect the cron.** It is sent after the result and its
HTTP status are already decided, it is bounded by a 3-second timeout, and both
the helper and the route swallow every failure. A monitoring outage cannot turn
a successful reminder run into a failed one, nor mask the original error when a
run genuinely failed — only a `heartbeat.failed` line appears.

**Nothing is sent to the provider but the request itself** — a bare GET with no
body, no query string and no headers of ours. There is no payload to review for
PII, reminder contents or internal error text, because there is no payload.

Configure the monitor with an expected interval matching the cron cadence (10
minutes) plus a grace period (5 minutes). If `heartbeat.skipped` appears in
Production logs, the variable is unset and **nothing is watching the scheduler**.

**What is never logged**, by type rather than by convention (see
`src/lib/observability/log.ts`): names, email addresses, phone numbers, gender,
attendance notes, membership-status or cancellation reasons, administrator
notes, push endpoints, and raw database error messages — any of which can carry
a constraint name, a column value or another tenant's identifier. Identifiers
are logged and are what make a log useful; looking a row up is an authorized act
with its own audit trail.

Suggested alerts, in priority order:

1. any `reminder.failed` — the reminder pipeline is broken;
2. **no `reminder.run` line for three cadence intervals** — the scheduler has
   stopped, which is the silent failure worth the most attention. Absence, not
   a value, is the signal;
3. any `action.failed`;
4. `/api/health` non-200 twice in a row;
5. any non-2xx from the cron endpoint, which the platform's own cron dashboard
   reports without extra wiring.

---

## 8. Troubleshooting notification delivery

The order to work in. Each step rules out a layer, and the first two are far
more often the problem than push itself.

### Step 1 — is the scheduler running at all?

```
event="reminder.run"        every cadence interval, healthy
event="reminder.failed"     the generator errored — see step 2
event="reminder.skipped"    no service-role key; nothing has ever run
```

**Silence is the finding.** `reminder.run` is emitted on every successful pass
including empty ones, precisely so its absence means something. No line for an
hour on a ten-minute cadence means the scheduler is not invoking the endpoint —
check the platform's cron dashboard and that `CRON_SECRET` is set, not the
application.

Confirm from outside with the `curl` in §5.

### Step 2 — did a run fail?

```
{"level":"error","event":"reminder.failed","error_code":"42501"}
```

`error_code` is the PostgreSQL SQLSTATE. The message is deliberately not logged
— it can carry a constraint name or another league's identifier.

| Code | Usually means | Action |
|---|---|---|
| `42501` | Insufficient privilege | The service-role key is wrong or rotated |
| `57014` | Statement timeout | Database under load; check Supabase metrics |
| `08*` | Connection failure | Database unreachable; check the project is not paused |

Reminders are **not lost** by a failed run: nothing was claimed, so the next
pass finds the same rows pending. Repeated failures are the emergency, not one.

### Step 3 — were the notifications created?

The in-app inbox is the source of truth. If a row exists here, the product did
its job and any remaining problem is delivery only.

```sql
select n.type, count(*), max(n.created_at) as latest
from public.notifications n
where n.match_id = '<match_id>'
group by n.type;
```

### Step 4 — did push go out?

```sql
select a.status,
       a.last_error_category,
       count(*)          as attempts,
       max(a.last_attempted_at) as latest
from public.push_delivery_attempts a
join public.notifications n on n.id = a.notification_id
where n.created_at > now() - interval '24 hours'
group by a.status, a.last_error_category
order by attempts desc;
```

**Retryable vs terminal**, from `status`:

| `status` | Retryable | Meaning and action |
|---|---|---|
| `pending` | — | Created, not yet attempted. Normal for seconds, not minutes |
| `sent` | — | Delivered to the push service. Nothing further to do |
| `temporary_failure` | **yes** | Service 5xx, rate limit, network, timeout. Self-corrects; investigate only if it persists across cadences |
| `permanent_failure` | **no** | Rejected and will never succeed. Almost always **VAPID credentials** — wrong key pair, or `VAPID_SUBJECT` not a `mailto:`. Fix the configuration; no amount of retrying helps |
| `invalidated` | **no** | The browser discarded the subscription (404/410). The row is retired automatically. The player must re-enable notifications on that device |

`last_error_category` refines it: `gone` / `not_found` are the invalidated pair,
`unauthorized` means credentials, `rate_limited` and `server_error` are the
push service's own problems, `payload_too_large` would be a defect in this
product and has never been observed.

A single subscription failing is ordinary — people clear site data and change
phones. **A spike of `permanent_failure` across many subscriptions at once is
almost certainly a configuration change**, not a hundred simultaneous device
failures.

### Step 5 — did the person actually opt in?

```sql
select s.enabled, count(*)
from public.push_subscriptions s
join public.league_memberships m on m.user_id = s.user_id
where m.league_id = '<league_id>'
group by s.enabled;
```

No row means they never enabled notifications on that device. On **iOS this is
the single most common cause**: Web Push requires the site to be on the Home
Screen first, and a player who skipped that step has no subscription at all and
never will until they do it. See §6.

### What an operator should actually do

| Finding | Action |
|---|---|
| No `reminder.run` lines | Fix the scheduler or `CRON_SECRET`. Nothing else matters until this is green |
| `reminder.failed` repeating | Treat as an incident. Check the service-role key and database health |
| `reminder.skipped` | Set `SUPABASE_SERVICE_ROLE_KEY` and redeploy |
| Notifications exist, push does not | Delivery problem only. The inbox is correct; players can still see everything in the app |
| `permanent_failure` spike | Re-check the VAPID pair and `VAPID_SUBJECT` |
| `invalidated` for one person | Ask them to re-enable notifications on that device |
| `reminder.push_incomplete` | Push threw for a whole occurrence. Notifications are safe; check push credentials and service status |

**Reassure the league before firefighting.** Push is a delivery channel, never
the record. A total push outage means phones stay quiet — it does not mean
anybody lost their spot, their roster, or their place in a queue.

---

## 9. Backups and the audit trail

Supabase takes automated backups; check the retention on your plan and match it
to what the league expects.

Two tables are the historical record and are never rewritten in place:

- **`audit_events`** — append-only. Every administrator decision, including the
  before-and-after of every attendance correction and every membership status
  change with its reason.
- **`notifications`** — what each person was actually told, and when.

Restoring to a point in time restores both. Neither is safe to prune without
deciding, explicitly, how much of a league's history it is acceptable to lose.

**Rehearse one restore before the pilot.** Knowing backups exist is not the same
as knowing you can use them, and the first time should not be during an
incident.

---

## 10. What this MVP does not have

Stated plainly so nobody deploys expecting it:

- no payments, billing or subscriptions
- no skill ratings, rankings, standings or league tables
- no automatic discipline of any kind (see `docs/operations/pilot.md` §4)
- no SMS, and no routine email beyond the sign-in link
- no native apps — it is a PWA
- no weather integration, tournaments, or guest sponsorship
- no analytics beyond the logs above
- no automated data-retention or deletion job
- **one administrator per league**, which makes a league one lost password away
  from being unmanageable. Recovery is an operational procedure:
  [`administrator-recovery.md`](administrator-recovery.md)

The last one matters for a real deployment: deleting a member's data is a manual
database operation today.

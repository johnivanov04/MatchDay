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
- **`APNS_SANDBOX_PRIVATE_KEY` and `APNS_PRODUCTION_PRIVATE_KEY` do the same
  for the iOS app.** Two, not one: Apple's key model is environment-specific.
  Both server-only and unprefixed. Unset, iPhone app devices are skipped rather
  than failed — see §6.
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

**Production migrations are applied by CI, not by hand.** Merging to `main`
runs `.github/workflows/deploy-production.yml`, which verifies the commit,
applies pending migrations, confirms parity, and only then deploys that same
commit to Vercel. Vercel's own production deploys are switched off
(`git.deploymentEnabled.main: false` in `vercel.json`) so there is exactly one
path to production.

### How CI reaches the production database

Over a **Session Pooler connection string**, held as `SUPABASE_DB_URL` in the
GitHub **`production`** environment. `supabase db push` and
`supabase migration list` both take `--db-url`, so the workflow talks to
Postgres directly and never touches the Supabase management API.

There is deliberately no `supabase link` step. It was tried and refused twice
with *"Authorization failed for the access token and project ref pair"* — a
project-scoped token with Project Settings READ and Migrations READ-WRITE
authenticates correctly but is not authorised for the endpoint `link` calls.
Rather than chase the right scope, the pipeline stopped needing one: migrations
are DDL against a single database, and a connection string is all they ever
required. That also collapsed three secrets into one.

The URL is supplied whole and used verbatim. Do not reconstruct it in the
workflow — the pooler's host, port and username all differ from the direct
`db.<ref>.supabase.co` endpoint, and guessing any of them turns a working deploy
into a failed one. It is passed by environment variable rather than interpolated
into a command line, so only the variable name appears in a run log.

The commands below remain correct for a local check or an emergency, and
`migration list` is safe to run at any time:

```bash
supabase link --project-ref <ref>
supabase migration list --linked   # read-only: what is applied, what is pending
supabase db push                   # normally CI's job, not yours
```

### The ordering rule, and why it exists

Build #2 shipped code to production while two migrations were still pending.
Vercel deployed on merge; the schema was applied by hand some time later; and in
between, every player who tapped "Enable phone notifications" was told **"You do
not have permission to do that"** — because `register_apns_device` did not exist
yet, and an unrecognised database error used to fall back to that message.

Two pipelines with no ordering between them will do that again. The workflow
removes the ordering question: no migration, no deploy.

### Migrations must be backward-compatible with the deployed application

**Database migration rollback is forward-only; code rollback is not.**

Vercel keeps previous deployments, so reverting the application is instant.
There is no equivalent for the schema: `supabase db push` only rolls forward,
and undoing a migration means writing and applying a new one.

The consequence is a rule that has to hold for every migration:

> A migration must leave the **previously deployed** application version working.

Because migrations are applied *before* the new code goes live, the old code is
briefly running against the new schema — and if a deploy is rolled back, it runs
against it for as long as the rollback lasts. So:

- **Add** columns, tables, types, functions and indexes freely.
- **Widen** constraints freely — dropping a `NOT NULL` or relaxing a `CHECK`
  cannot break code that was already satisfying the stricter version.
- **Do not** drop or rename a column, table or function the deployed code still
  reads, and do not narrow a constraint in the same migration that starts
  writing values which satisfy it. Split those across two releases: add and
  backfill first, remove once nothing references it.

The Build #2 and Build #3 migrations are all of the first two kinds. The one
signature change so far — `record_push_delivery_result` gaining a parameter —
kept the new argument defaulted precisely so the previously deployed dispatcher,
which passes four arguments, keeps working.

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

The SQL route creates the canonical in-app notifications *and*, since Phase 3B,
their delivery jobs — the trigger on `notifications` fires whoever does the
insert, so a `pg_cron` schedule no longer loses the push. It still needs
`/api/cron/notification-delivery` running to drain the queue. Prefer the HTTP
route where the platform allows it, so both halves are scheduled the same way.

### What is in the repository, and what is not

`vercel.json` declares three cron entries:

```json
{ "crons": [
  { "path": "/api/cron/reminders",             "schedule": "*/10 * * * *" },
  { "path": "/api/cron/account-deletion",      "schedule": "17 * * * *" },
  { "path": "/api/cron/notification-delivery", "schedule": "* * * * *" }
] }
```

All three share `CRON_SECRET` and the same 404-without-it behaviour, so there is
one secret to rotate and one authorization model to understand.

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

This creates the canonical in-app notifications and their delivery jobs; the
queue worker sends them. Before Phase 3B the fan-out lived in the application and
this route lost it. Prefer the HTTP route wherever possible.

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
  and nothing in the interface can work around it. Players using the App Store
  app do not need this — they get APNs instead, below.

### The iOS app: APNs

The native app cannot use Web Push at all — `PushManager` does not exist in a
WKWebView — so it registers with Apple directly and MatchDay sends over HTTP/2.

| Variable | What it is |
| --- | --- |
| `APNS_TEAM_ID` | The ten-character Team ID. Becomes the `iss` claim |
| `APNS_BUNDLE_ID` | `com.johnivanov.matchday`. Becomes the `apns-topic` header |
| `APNS_SANDBOX_KEY_ID` | Key ID of the Sandbox APNs key |
| `APNS_SANDBOX_PRIVATE_KEY` | That key's `.p8`, downloadable exactly once |
| `APNS_PRODUCTION_KEY_ID` | Key ID of the Production APNs key |
| `APNS_PRODUCTION_PRIVATE_KEY` | That key's `.p8` |

**Two keys, because Apple's key model is environment-specific** and its current
guidance is to hold separate Sandbox and Production keys. An older key issued
before that distinction works in both and may continue to — but "may continue
to" is not something to build on, and the day it stops the only symptom is that
TestFlight testers quietly stop getting alerts. If you hold such a key, put the
same Key ID and the same `.p8` in both pairs; that is a supported configuration.

**Unset, nothing breaks.** APNs devices are skipped: nothing is attempted and
nothing recorded, so adding a key later begins delivery with no backlog of
permanently-failed rows. One environment configured and not the other is also
normal — a deployment serving only the App Store build has no reason to hold a
sandbox key, and only its sandbox devices are skipped.

#### Which environment a device is in

Stored per row, never guessed. A token minted against Apple's sandbox is
meaningless to production and vice versa, and the rejection — `BadDeviceToken` —
is indistinguishable from a corrupt token.

The app reports it from `MATCHDAY_APNS_ENVIRONMENT`, an ordinary Xcode build
setting surfaced through `Info.plist`:

| Configuration | Value | Signed `aps-environment` |
| --- | --- | --- |
| Debug (device build from Xcode) | `sandbox` | `development` |
| Release (Archive → TestFlight → App Store) | `production` | `production` |

This is deliberately boring. Reading the signed entitlement at runtime needs
either `SecTaskCopyValueForEntitlement` — which links on iOS but is declared
only in the macOS SDK, making it a private symbol — or a parser for the
`LC_CODE_SIGNATURE` blob, which depends on undocumented code-signing layout in a
binary Apple re-signs on the way to the App Store. Both were rejected.

**Development APNs verification must use the Debug configuration.** Running
Release directly from Xcode against a development profile is not a supported
APNs test setup: the entitlement would say `development` while the build setting
says `production`, and every send would be addressed to the wrong host.

#### Reading a failure

**A 403 does not mean a dead phone.** APNs reports provider-credential problems
with statuses that also cover device problems, so MatchDay classifies on the
`reason` string. Exactly three reasons retire a registration:

| Reason | Meaning |
| --- | --- |
| `Unregistered` | The app was deleted from that device |
| `ExpiredToken` | The same, reported the other way |
| `BadDeviceToken` | APNs will not accept the token — and because the row records its own environment, the usual innocent cause of this cannot arise |

Everything else leaves the device enabled. In particular
**`DeviceTokenNotForTopic` does not retire anything**: it says the token does not
match the topic the request claimed, and the topic is `APNS_BUNDLE_ID` — so a
wrong bundle identifier, a key issued for a different app, or an upstream
environment mismatch all produce it. Retiring on it would empty the device table
over one wrong environment variable. It records `permanent_failure`, which
`record_push_delivery_result` does not act on, so the row is untouched and
delivery resumes the moment the configuration is corrected.

`ExpiredProviderToken` is handled rather than recorded: the cached signing JWT is
dropped, a fresh one is signed, and the send is retried **exactly once**. Only
the final outcome is recorded, so a recovered send leaves no failure behind. The
retry is straight-line and cannot re-enter — retrying a credential APNs has
already refused is how `TooManyProviderTokenUpdates` happens.

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

## 6b. The notification delivery queue

Phase 3B moved provider delivery out of the request. Before it, publishing a
match meant the administrator's request stayed open while the server talked to
APNs and Web Push once per device of every member of the league. Measured
locally against a 150-member fanout at a simulated 60 ms provider round trip,
that was **9.3 seconds** of the request; the enqueue that replaced it costs
**2.4 ms**.

### How a notification becomes a push

```
domain RPC (publish_match, decide_join_request, generate_due_reminders, …)
  └─ INSERT INTO notifications                     ─┐  one transaction
       └─ TRIGGER notifications_enqueue_delivery    │  both rows or neither
            └─ INSERT INTO notification_delivery_jobs
                                                   ─┘
… request returns here …

/api/cron/notification-delivery  (every minute)
  └─ claim_notification_delivery_jobs()   for update skip locked, bounded
  └─ dispatchPushNotifications()          APNs / Web Push
  └─ record_push_delivery_result()        per (notification, subscription)
  └─ complete_notification_delivery_job() terminal
```

The enqueue is a **trigger**, not a call the application makes. That is what
removes the window in which a notification could exist with no delivery job —
and it is why approving a join request now pushes, which it never did: the
membership action was the one fanout path that forgot to call the old push seam.

### The delivery guarantee is at-least-once

Not exactly-once, and it must not be described as such.

- The job commits with the notification, so work cannot be **lost**.
- A worker killed after sending but before recording leaves a lease that
  expires; the job is claimed again and the send can genuinely **happen twice**.

What makes a duplicate *alert* unlikely is one layer down and is not part of the
guarantee: `push_delivery_attempts` is unique per (notification, subscription)
and the dispatcher skips any pair already in a terminal state. The provider call
happens before that row is written, and nothing can make those two atomic across
a network boundary.

### The lease is crash recovery; the backoff is provider retry

Two different mechanisms, two different columns, deliberately never mixed.

**Lease reclaim.** A job stuck in `processing` past `lease_expires_at` belonged
to a worker that died — a redeploy, a function timeout, a reclaimed instance —
and is picked up again. It ignores `next_attempt_at`, because a crashed worker
is not waiting on a provider. It increments `attempts` and **never**
`provider_attempts`, so a bad deploy cannot quietly spend every in-flight
notification's retry budget.

**Provider retry (Phase 3C).** A delivery round that left at least one
subscription in `temporary_failure` returns the job to `pending` with a future
`next_attempt_at`:

| temporary failure | next attempt |
|---|---|
| 1st | +1 minute |
| 2nd | +2 minutes |
| 3rd | +5 minutes |
| 4th | +15 minutes |
| 5th | terminal `failed`, category `retries_exhausted` |

At most **five** provider delivery rounds. No jitter: the fleet is a single cron
on a one-minute tick, so there is no herd to spread out.

The schedule lives in `reschedule_notification_delivery_job`, not in the worker.
Two workers racing on one job cannot compute two different next-attempt times,
and there is no constant in TypeScript to drift from the column in Postgres.

**Never retried:** `permanent_failure` and `invalidated` are terminal per
(notification, subscription) and always were. A notification with no enabled
subscriptions is `completed`, not retried — there is nothing owed.

### Partial fanout

A notification reaching one phone and being rate limited on another is **not**
finished. The job is rescheduled, and the next round re-sends to nobody who
already has it: `push_delivery_attempts` is unique per (notification,
subscription) and the dispatcher skips any pair already `sent`,
`permanent_failure` or `invalidated`.

So the retry is per-subscription in effect, while the queue stays per-notification.

### Operating it

The queue is service-role only: RLS is enabled and forced with **no policies**,
`authenticated` holds no grant, and both RPCs re-check `auth.role()`. There is
no member-facing view of it and there should not be one.

```sql
-- Queue depth by state. The number that matters is `pending` not growing.
select status, count(*), min(created_at) as oldest
  from public.notification_delivery_jobs
 group by status order by status;

-- Why jobs ended. Three distinguishable terminal causes:
--   retries_exhausted   → the provider kept saying "try later" and we stopped
--   all_attempts_failed → the provider said "never" (permanent / invalidated)
--   dispatch_error      → our own fault; the pass could not be carried out
select last_error_category, count(*)
  from public.notification_delivery_jobs
 where status = 'failed'
 group by 1 order by 2 desc;

-- Work currently backed off, and how long until it is due.
select id, provider_attempts, next_attempt_at,
       next_attempt_at - now() as due_in
  from public.notification_delivery_jobs
 where status = 'pending' and next_attempt_at > now()
 order by next_attempt_at;
```

`pending` climbing steadily means the worker is not running (check the cron
dashboard and `CRON_SECRET`) or has nowhere to send (`notification_delivery.skipped`
in the logs — no service-role key, or no VAPID and no APNs credentials). A
deployment with no transport deliberately leaves jobs `pending` rather than
completing work it could not do, so nothing is discarded when credentials
finally arrive.

Batch and time bounds live in `src/server/notification-delivery.ts`: 25 jobs per
claim, 200 per pass, a 45-second budget, and a 120-second lease. The SQL clamps
the batch to 100 regardless of what the caller asks for.

### No backfill

The migration deliberately enqueues nothing that already existed. Every
push-eligible notification present when it ran had already been through the
inline dispatcher, and enqueueing them would have made the worker's first run
light up every phone in the product with alerts about matches played weeks ago.

## 6c. Email notifications

Phase 3D added a second delivery channel to the same queue. One canonical
notification, one delivery job, two channels — the job is finished when every
applicable channel has reached a terminal outcome.

### Nobody is emailed by default

`notification_preferences.email_enabled` defaults to **false**, and no row
exists for anybody until they switch it on at `/settings/notifications`.
Absence means off, so shipping the phase emailed nobody and no backfill ran.
Turning it on affects notifications created afterwards; it does not reach back
for last week's matches, because those jobs reached a terminal state long ago.

### Who an email actually goes to

`notification_email_recipient(notification_id)` is the single gate, and returns
NULL for "nobody":

1. the notification exists
2. the recipient has `email_enabled = true`
3. the account is not being deleted
4. `auth.users.email` is present **and** `email_confirmed_at` is not null

`auth.users` is the source, not `profiles.email_normalized` — the latter is a
lowercased copy of a JWT claim and knows nothing about verification. An
unverified address may belong to somebody else entirely, and sending league
activity to it would leak one member's matches into a stranger's inbox.

NULL is a **legitimate no-op**: no attempt row, no provider call, and no retry
work. Waiting does not conjure a confirmed address.

### Provider

Resend, over its HTTPS API. No SMTP — there is no SMTP infrastructure here to
reuse, and a long-lived socket is the wrong shape for a function that may be
frozen between two sends.

```
RESEND_API_KEY   server-only
EMAIL_FROM       server-only; its domain must be verified with Resend
```

Both optional. With either unset the channel is unavailable, push is unaffected,
and nothing reads them at startup — a deployment without email starts and serves
exactly as before.

### Duplicate protection, and what it is not

Every send carries an `Idempotency-Key` header:

```
matchday/notification/<notification-id>/email/v1
```

Deterministic per notification and identical on every retry, so Resend
de-duplicates a repeat within its 24-hour window. The notification id and
nothing else: no address, no user id, no secret — the key travels to a third
party and is echoed in their dashboards.

**This does not make delivery exactly-once.** The queue is still at-least-once;
the provider call still precedes the row that records it. What the key buys is
that the most likely duplicate — a worker killed between acceptance and
bookkeeping — is absorbed by the provider rather than landing in an inbox
twice. A duplicate email is worse than a duplicate push: it is permanent,
searchable and forwardable.

**Resend retains an idempotency key for 24 hours.** The complete 3C ladder is
1 + 2 + 5 + 15 = **23 minutes of scheduled backoff**, so an ordinary retry
sequence finishes with more than 23 hours of margin. That margin is against
*scheduled* delay only: a worker that is not running, or a queue that is not
drained, adds wall-clock time the ladder knows nothing about. An outage long
enough to push a retry past 24 hours would find the key expired and the
suppression gone — the send would be accepted as new. Rare, and worth knowing
rather than assuming away.

### The payload has to match the key as well

Resend de-duplicates on the key **and** an identical payload. Same key, changed
payload, and it answers `409 invalid_idempotent_request`.

Our key is stable by construction, but the payload is not guaranteed to be:
`to` is resolved from `auth.users` on every worker pass, and somebody can
confirm a new address between the first attempt and the retry. `EMAIL_FROM` and
`NEXT_PUBLIC_SITE_URL` are operator-settable too.

So the first real provider request records a SHA-256 of the canonicalised
request in `email_delivery_attempts.payload_fingerprint` — a hash, never the
content, so the recipient is still not stored. A later retry re-renders and
compares. If it differs, **Resend is not called**: the job's email channel ends
with `idempotency_payload_changed`.

Minting a fresh key for the new address would be worse. If the original request
actually reached Resend and only our response was lost, a new key is a second
email.

### The two 409s

| Resend `name` | meaning | treatment |
|---|---|---|
| `concurrent_idempotent_requests` | another request with this key is still in flight | **temporary** — `concurrent_request`, retried on the 3C ladder |
| `invalid_idempotent_request` | this key was already used with a different payload | **permanent** — `idempotency_mismatch`, operator-visible |
| `invalid_idempotency_key` | the key itself is malformed | **permanent** — `invalid_idempotency_key` |
| 409 with no recognised name | ambiguous | **temporary** — one wasted retry beats a dropped notification |

The structured error name is read from the response body and the message is
discarded — a Resend error message can quote the recipient and the subject. The
name is validated to a short machine-token shape, so a provider change cannot
turn it into a channel for arbitrary text.

Treating both 409s alike — which a bare status check does — silently drops a
message that would have gone out a minute later.

### Failure classification

| provider answer | outcome |
|---|---|
| 429 | `temporary_failure` / `rate_limited` |
| 5xx | `temporary_failure` / `server_error` |
| timeout, network fault | `temporary_failure` / `timeout`, `network` |
| **401, 403** | `permanent_failure` / `unauthorized` — **operator action needed** |
| 400, 422 | `permanent_failure` / `invalid_request` |
| 404, 413, other 4xx | `permanent_failure` |

Retries use Phase 3C's existing ladder — 1m, 2m, 5m, 15m, then
`retries_exhausted`. There is no separate email retry loop and no sleeping in
the worker.

A bad or revoked API key, or an unverified sending domain, is **permanent**.
Retrying it five times only asks the same question on a schedule; the fix is a
person changing configuration.

### Partial fanout across channels

A notification that reached both phones but was rate limited by Resend is **not**
finished. The job is rescheduled and the next pass sends only the email —
`push_delivery_attempts` marks the delivered pairs terminal and
`email_delivery_attempts` does the same for the address, so each channel skips
what it already did. The reverse holds identically.

### Operating it

```sql
-- Email outcomes.
select status, count(*) from public.email_delivery_attempts group by status;

-- Why emails failed. `unauthorized` means somebody has to fix configuration.
--   unauthorized                → somebody must fix configuration
--   idempotency_mismatch        → same key, different payload; a bug in us
--   idempotency_payload_changed → the recipient or sender moved mid-retry
select last_error_category, count(*)
  from public.email_delivery_attempts
 where status in ('temporary_failure','permanent_failure')
 group by 1 order by 2 desc;

-- How many people have opted in.
select count(*) filter (where email_enabled) as opted_in,
       count(*)                              as rows_present
  from public.notification_preferences;
```

The attempt table stores **no recipient address**, deliberately: a copy there
would sit outside `auth.users`, where account deletion already knows how to
scrub it, and would need its own erasure path to avoid outliving the account.
`provider_message_id` is the handle Resend's own tooling answers to.

## 7. Observability

Server logs are single-line JSON on stdout, which every host collects and
indexes. There is no agent and no vendor.

| Event | Level | Meaning |
|---|---|---|
| `action.refused` | info | A Server Action returned a domain error. Usually the product working — somebody tried to join a full match. Watch the aggregate, not the line |
| `action.rejected_input` | warn | Malformed input — a bad UUID, a stale form, a hand-crafted POST. **Never page on this**; see below |
| `action.failed` | error | Something threw that nobody anticipated, carrying `severity: "unexpected"`. **Page on this** |
| `action.dependency_failed` | error | The database said something this application does not model — a lost connection, a statement timeout, a new constraint. Carries `severity: "unexpected"` and the SQLSTATE. **Page on this** |
| `reminder.run` | info | A reminder pass completed, with `claimed` / `notified`. Emitted on empty passes too, so its **absence** is the signal |
| `reminder.failed` | error | The generator errored; nothing was claimed. **Alert on this** |
| `reminder.skipped` | warn | No service-role key configured, so nothing ran |
| `notification_delivery.run` | info | A delivery pass completed, with `claimed` / `completed` / `failed` / `rescheduled` / `exhausted` / `sent` / `mail_sent` / `duration_ms`. Emitted on empty passes too |
| `notification_delivery.failed` | error | The queue itself could not be read or written; nothing was drained. **Alert on this** |
| `notification_delivery.skipped` | warn | No service-role key, or no push transport configured. **Jobs are accumulating unsent** |
| `notification_delivery.incomplete` | warn | At least one notification reached none of its devices |
| `notification_delivery.retry_scheduled` | info | A delivery round hit a retryable provider failure; carries `retry_number` and `next_attempt_at` |
| `notification_delivery.retry_exhausted` | warn | Five temporary failures; the job is now terminally `failed`. **Worth alerting on a sustained rate** |
| `notification_delivery.stale_claim` | warn | A job was finished under another worker's claim. Rare; repeated occurrences mean the lease is shorter than a batch takes |
| `heartbeat.sent` | info | The external heartbeat was pinged, with `kind` = `success` or `failure` |
| `heartbeat.failed` | warn | The monitoring provider was unreachable or answered non-2xx. **Does not affect the cron result** |
| `heartbeat.misconfigured` | warn | `REMINDER_HEARTBEAT_URL` is set but unusable — **monitoring is silently off** |
| `heartbeat.skipped` | info | No heartbeat configured. Expected locally and on Preview; **unexpected in Production** |

The first three come from `actionFailure()`, so every Server Action is covered
without each one having to remember to log; the fourth comes from the database
error mapping.

### Why `action.failed` alone is not the alert

An earlier version of this document said to alert on *any* `action.failed`. That
was wrong in both directions, and the correction is the reason these four events
exist.

**It was too loud.** Every action validates its form fields with Zod, and ~94 of
those calls throw on malformed input. A stale form or a hand-crafted POST landed
in the same bucket as a genuine fault — so anybody could `POST league_id=x` to a
server action and manufacture pages indefinitely. Those are now
`action.rejected_input` at `warn`: worth watching in aggregate (a sudden spike
means either a broken client or somebody probing), never worth waking anybody.

**It was too quiet.** An unrecognised database error fell through the mapping's
catch-all into an ordinary `DomainError`, which is logged as `action.refused` at
**info**. The single failure most worth paging for — the database being
unreachable — was the quietest line in the logs. It is now
`action.dependency_failed` at `error`.

**Filter on `severity`, not on the exception class.** `severity: "unexpected"`
is our own stable contract; a library's class name is not, and would change
silently under a major version bump.

### Vercel Log Drain → Better Stack

These events are monitored by draining Vercel's stdout to Better Stack and
filtering there, rather than by MatchDay calling a webhook.

That choice is deliberate: `actionFailure` runs **inside the user's request**.
The reminder heartbeat can afford an awaited outbound call because it is a cron
with a ten-minute cadence and nobody waiting; a signup is not that. Putting a
third-party HTTP call in the path of every unexpected failure would add latency
exactly when the system is already unhealthy, and a slow provider would make a
bad request worse. A drain adds nothing to the request path at all, and the
filter can be retuned without a deploy.

Alert on `action.failed` and `action.dependency_failed`. Do **not** alert on
`action.rejected_input` or `action.refused`; graph them instead.

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

0. any `action.dependency_failed` — the database is not answering as expected;
2. **no `reminder.run` line for three cadence intervals** — the scheduler has
   stopped, which is the silent failure worth the most attention. Absence, not
   a value, is the signal;
3. any `action.failed` (`severity: "unexpected"`) — never
   `action.rejected_input`, which is ordinary malformed input;
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

## 10. Universal Links (Apple App Site Association)

`/.well-known/apple-app-site-association` is served by a route handler
(`src/app/.well-known/apple-app-site-association/route.ts`) rather than a file
in `public/`, because Apple requires no file extension *and*
`Content-Type: application/json` — and a `public/` file with no extension is
served as `application/octet-stream`, which makes the association fail with no
error anybody sees.

`src/proxy.ts` excludes `.well-known`, so Apple's fetch does not trigger a
Supabase session lookup on the way past.

### Nothing is verified until it is deployed

**Do not describe Universal Links as working before the checks below pass on the
public endpoint.** Apple's association system fetches this document from the
internet through its own CDN and caches the result. A local test proves the
document MatchDay serves and nothing else: no link has been verified by Apple
until the endpoint is live on the real origin.

After deploying, verify the real endpoint:

```bash
curl -sI https://app.matchdayapps.com/.well-known/apple-app-site-association
```

Confirm, in this order:

1. **`HTTP/2 200`** — not 301, 302, 307 or 308. Apple does **not** follow
   redirects for this document, so a redirect is a silent failure.
2. **`content-type: application/json`**.
3. The body is valid JSON and carries the right app id:

```bash
curl -s https://app.matchdayapps.com/.well-known/apple-app-site-association \
  | python3 -m json.tool
# appIDs must be exactly ["VYC3499K46.com.johnivanov.matchday"]
```

Only once all three hold can the association be exercised for real: install the
app on a physical iPhone, then tap a MatchDay link from Notes or Messages —
**not** from Safari's address bar, which never triggers a Universal Link. A
long-press showing "Open in MatchDay" confirms the association resolved.

`swcutil` on a Mac and Console.app filtered on `swcd` show the device's own view
of the association, which is the fastest way to tell "Apple has not fetched it
yet" apart from "Apple fetched it and rejected it".

Apple's CDN caches aggressively, so a wrong first publish is slow to correct.
That is why this document ships ahead of the app build rather than with it.

---

### Verifying an iOS build before uploading

Four facts can only be established by building, so they are checked against the
artefact rather than asserted in a test. `tests/unit/ios-project.test.ts` pins
the project settings that produce them.

```bash
# 1. Debug resolves to sandbox, Release to production.
xcodebuild -project ios/App/App.xcodeproj -target App -configuration Debug \
  -showBuildSettings | grep MATCHDAY_APNS_ENVIRONMENT
xcodebuild -project ios/App/App.xcodeproj -target App -configuration Release \
  -showBuildSettings | grep MATCHDAY_APNS_ENVIRONMENT

# 2. The signed entitlements. Development build → development; the App Store
#    export → production. Xcode rewrites it at export, not at archive, so an
#    archive still shows `development` and that is correct.
codesign -d --entitlements :- <path>/App.app

# 3. The privacy manifest is actually in the bundle. It was not in Build #1.
ls <path>/App.app/PrivacyInfo.xcprivacy

# 4. The build number has moved on. App Store Connect refuses a re-upload of
#    one it already has.
/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' <path>/App.app/Info.plist
```

---

## 11. What this MVP does not have

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

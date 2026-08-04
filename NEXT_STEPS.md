# Next steps

Phase 1 is complete. This document covers what to do before Phase 2, and what
Phase 2 should start with.

---

## 1. Manual setup still required

The repository has no credentials and no Supabase project, so these steps cannot
be automated from here.

### a. Install the local toolchain

```bash
brew install --cask docker          # or install Docker Desktop
brew install supabase/tap/supabase  # Supabase CLI
```

Neither Docker nor the Supabase CLI was available in the environment where Phase
1 was built, which is why `supabase db reset`, `supabase migration up` and
`supabase db seed` have **not** been executed. Every migration and the seed file
*have* been executed and asserted against a real PostgreSQL 18 server by the test
suite, but running them once through the Supabase CLI is still worth doing.

### b. Start Supabase and apply the schema

```bash
npx supabase start
npm run db:reset        # migrations + seed
npm run test:db         # re-run against the real Supabase stack:
                        # TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:db
```

The last step matters: it confirms the migrations behave identically on
Supabase's PostgreSQL 17 image as on the harness's PostgreSQL 18.

### c. Fill in `.env.local`

`supabase start` prints the API URL and anon key.

```bash
cp .env.example .env.local
```

Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and
`NEXT_PUBLIC_SITE_URL=http://localhost:3000`. Leave
`SUPABASE_SERVICE_ROLE_KEY` unset unless something needs it — nothing in Phase 1
does.

### d. Verify the flow by hand

1. `npm run dev`
2. Sign in as `player.multi@matchday.test`.
3. Collect the link or the 6-digit code from <http://127.0.0.1:54324>.
4. Complete onboarding, then confirm the switcher offers **both** RMV Football
   Club and Weeknight 5v5, and that switching persists across a reload.

### e. Create the hosted project (when ready to deploy)

1. Create a Supabase project; run `supabase link` and `supabase db push`.
2. Set the site URL and add `<origin>/auth/callback` to the allowed redirect
   URLs. Sign-in links will not work otherwise.
3. Configure the Vercel project's environment variables. Keep
   `SUPABASE_SERVICE_ROLE_KEY` out of any client-visible scope.
4. Confirm `matchday.environment` is set to `production` on the production
   database so the development seed refuses to run there:
   ```sql
   ALTER DATABASE postgres SET matchday.environment = 'production';
   ```

---

## 2. Review before Phase 2

Worth a human read, in this order:

1. `supabase/migrations/20260803011000_row_level_security.sql` — every policy in
   one file.
2. `supabase/migrations/20260803010500_single_active_admin.sql` — the deferred
   constraint trigger, and why the partial unique index is not deferrable.
3. `supabase/migrations/20260803011100_grants.sql` — deny-by-default privileges.
4. `tests/db/cross-league-isolation.test.ts` — the Phase 1 acceptance gate,
   expressed as assertions.

Two judgement calls to confirm or overturn:

- **Administrator notes were split into their own table**
  (`league_membership_admin_notes`) rather than living on `league_memberships`
  as `02 §17` sketches. RLS cannot hide a single column from a row a member is
  allowed to read, so keeping notes on that row would expose them to the member
  they describe.
- **`leagues` rows are readable by any non-removed membership**, including
  `pending` and `suspended`. The switcher needs the league name; a *pending
  applicant* with only a join request (Phase 2) is a different thing and will
  use the restricted public projection instead.

---

## 3. Recommended first Phase 2 task

**Build `createLeague` as a single transactional database function, together
with the create-league flow.**

Everything else in Phase 2 depends on being able to create a league, and this
task is where the Phase 1 constraints are actually exercised:

- The league row and its administrator membership must be inserted in **one
  transaction**. `enforce_single_active_league_admin` runs at `COMMIT` and
  rejects a league that has no active administrator, so two separate statements
  cannot work.
- `authenticated` holds no INSERT privilege on `leagues`, by design. Creation
  therefore needs a `SECURITY DEFINER` function that derives the creator from
  `auth.uid()` — matching the pattern already established by
  `public.record_audit_event`.
- New leagues default to `private` (`PRD §6`), which the column default already
  enforces.
- The creator becomes the sole administrator, and the flow should record a
  `league.created` audit event through the existing `recordAuditEvent` helper.

Suggested shape:

```sql
create or replace function public.create_league(p_input jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$ … $$;
```

with the server action validating input via Zod, and integration tests asserting
that: a league cannot be created without a session; the creator becomes the
single active administrator; a duplicate slug is rejected; and the new league is
invisible to every other user.

**Then**, in order: administrator transfer (the demote-then-promote ordering is
already tested), join requests, invitations, and the public search projection
view.

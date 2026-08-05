# Next steps

Phases 1 and 2 are complete. This document covers what to verify by hand, what
to review, and what Phase 3 should start with.

---

## 1. Manual verification

The local toolchain (Docker, Supabase CLI) is installed and working; `npm run
db:reset` applies all 18 migrations and the seed.

```bash
npx supabase start        # if not already running
npm run db:reset
npm run dev
```

Sign-in emails are captured at <http://127.0.0.1:54324> and never leave the
machine. Seeded accounts all use the reserved `.test` TLD.

### Walk the Phase 2 flows

1. **Create a league.** Sign in as `outsider@matchday.test` → *Create a league*.
   Confirm the new league is **private**, that you are its administrator, and
   that it becomes your active league.
2. **Publish it.** Settings → *Make this league searchable*. Read the panel that
   lists exactly what becomes public.
3. **Discover and request.** Sign in as `player.rmvfc@matchday.test` →
   *Find a league*. The new league appears; RMV Football Club does **not**.
   Send a join request, then confirm *Awaiting approval* appears and the button
   is gone.
4. **Approve.** Back as the administrator → *Members* → Approve. Click Approve a
   second time and confirm no second membership appears.
5. **Invite.** Members → create an invitation link. Copy it — it is shown once.
   Open it in a private window as a different account; you should be asked to
   sign in and returned to the invitation afterwards. Redeem it twice and
   confirm the use count only increments once.
6. **Revoke.** Revoke the link, then try it again: it must fail with the same
   message an unknown link gives.
7. **Transfer.** Members → Transfer administration to an active player, typing
   `transfer` to confirm. Confirm you become an ordinary player immediately and
   the administrator links disappear.
8. **Audit.** As the new administrator, confirm the settings and membership
   changes were recorded.

### Confirm the public boundary directly

```bash
# Anonymous: only searchable leagues, only seven columns.
curl -s "http://127.0.0.1:54321/rest/v1/searchable_leagues_public?select=*" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"

# Anonymous against the base table: must be denied.
curl -s "http://127.0.0.1:54321/rest/v1/leagues?select=*" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"
```

---

## 2. Review before Phase 3

Worth a human read, in this order:

1. `supabase/migrations/20260803020100_public_league_search.sql` — the public
   projection, and why it is a view rather than a policy.
2. `supabase/migrations/20260803020200_league_management_functions.sql` — every
   Phase 2 operation, each deriving its actor from `auth.uid()`.
3. `supabase/migrations/20260803020500_harden_admin_cardinality_trigger.sql` and
   `…020600_function_execute_hardening.sql` — two real defects found by the
   Phase 2 test suite. Both are documented at length in the migrations
   themselves and summarised in `TODO.md`.
4. `tests/db/public-search.test.ts` and `tests/db/phase2-isolation.test.ts` —
   the tenancy boundary expressed as assertions.

Judgement calls to confirm or overturn:

- **`logo_url` and `public_contact` are withheld from public search.** F-02
  lists them as league fields and their names suggest they are publishable, but
  PRD §12 enumerates what a public result may contain and lists neither. Adding
  a column later is easy; un-leaking one is not.
- **Slugs are immutable after creation.** The settings form omits the field so
  an edit cannot silently break links people already hold.
- **A pending or suspended member can read their league's row**, which the
  switcher needs. A *pending applicant* — someone with only a join request — has
  no membership and sees only the public projection.

---

## 3. Recommended first Phase 3 task

**Versioned league guidelines and acknowledgement (F-04) — schema, RLS, and the
acknowledgement gate — before any match work.**

It is the right next task for three reasons:

- **It is the last thing standing between membership and matches.** Signup
  eligibility in F-06 lists "required guideline acknowledgement" alongside
  active membership. Building matches first means building signup twice.
- **It reuses the Phase 2 shape exactly.** `guideline_versions` and
  `guideline_acceptances` are league-scoped, administrator-written,
  member-read — the same policy pattern as `league_join_requests`, and the same
  `log_audit_event` path for `guidelines.published`.
- **It carries the one genuinely new rule in Phase 3's data model:**
  acknowledgements are immutable and per-version, so a new required version
  blocks signup *in that league only*. That is a per-tenant gate worth getting
  right while the surface is still small.

Suggested shape:

```sql
create table public.guideline_versions (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete cascade,
  version_label text not null,
  title text not null,
  body text not null,
  content_checksum text not null,
  requires_acceptance boolean not null default true,
  effective_at timestamptz not null default now(),
  published_at timestamptz,
  archived_at timestamptz,
  ...
);
-- unique (league_id, version_label)
-- at most one published, unarchived version per league

create table public.guideline_acceptances (
  league_id uuid not null,
  membership_id uuid not null,
  guideline_version_id uuid not null,
  accepted_at timestamptz not null default now(),
  ...
);
-- unique (membership_id, guideline_version_id); no UPDATE or DELETE policy
```

with a `public.current_guideline_version(league_id)` helper and a
`public.has_accepted_current_guidelines(league_id)` predicate that Phase 4's
signup path can call directly. Tests should assert that a player is eligible in
one league and blocked in another purely because of guideline status, and that
acknowledgement history cannot be rewritten.

**Then**, in order: match templates, match creation and publication, and the
in-app notification centre — keeping notification events channel-independent, as
[ADR 0001](docs/decisions/0001-notifications-in-app-center-plus-web-push.md)
requires, because Web Push arrives later on top of the same events.

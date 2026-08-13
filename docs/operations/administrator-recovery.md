# Emergency administrator recovery

Restoring administration of a league when the sole administrator can no longer
reach it.

Every step below has been executed against a real database and rolled back. The
SQL is not illustrative.

---

## 1. Why this document exists

The MVP allows **exactly one active administrator per league** (`01 §8`), and
that is enforced by a deferred constraint trigger, not by convention:

```
LEAGUE_ADMIN_CARDINALITY: league <id> must have exactly one active
league_admin, found 0
```

A league therefore **cannot** end up with zero administrators — every attempt to
suspend, remove or demote the last one is refused at COMMIT, and Phase 7's
`set_membership_status()` refuses it earlier with a clearer message. That is
worth knowing before you start: the membership row is intact. What has been lost
is the *person's access to it*.

The in-app path is `transfer_league_administration()`, reachable from **Members →
Transfer administration**, and it requires the **current** administrator to be
signed in. That covers every ordinary handover, including somebody leaving the
club. This document is only for when that path is unavailable.

---

## 2. When emergency recovery is appropriate

Use it only when **all** of these are true:

1. The league has an active administrator on paper, and
2. that person cannot sign in — lost access to their email address, left the
   organisation, incapacitated, account compromised — and
3. the ordinary in-app transfer is therefore impossible, and
4. somebody with authority over the league has asked for the change and can
   name the replacement.

**Do not use it** for: an administrator who simply has not got round to
transferring; a dispute between members about who should run a league; a
password reset (send a fresh magic link instead); or a request that arrives
without the identity of the requester being established.

An administrator can read every member's contact details, private notes,
attendance records and disciplinary reasons. Handing that to the wrong person is
not recoverable by undoing the SQL.

---

## 3. Who may perform it

Whoever holds the production `SUPABASE_SERVICE_ROLE_KEY` or direct database
access — in practice the platform operator, not a league administrator.

Two rules:

- **Two people.** One runs it, one reviews the identifiers before the
  transaction commits. Every step below is inside an explicit transaction so a
  second pair of eyes can check the `SELECT` output before `COMMIT`.
- **Establish the requester's authority out of band** — a known phone number, a
  club officer, an existing relationship. Not by replying to the email that
  asked for it.

---

## 4. Identify the league and the replacement

Read-only. Run this first and keep the output with the ticket.

```sql
select l.id           as league_id,
       l.slug,
       l.name,
       m.id           as membership_id,
       m.role,
       m.status,
       p.email_normalized
from public.leagues l
join public.league_memberships m on m.league_id = l.id
join public.profiles p on p.id = m.user_id
where l.slug = '<league-slug>'
order by m.role, p.email_normalized;
```

Confirm all four before going further:

- exactly one row with `role = league_admin` and `status = active` — that is the
  membership being vacated;
- the replacement's row has `role = player` **and** `status = active`. A
  `pending`, `suspended` or `removed` member cannot receive administration, and
  the function will refuse;
- the replacement's email is the person the requester actually named;
- the `league_id` is the league you were asked about, not a similarly named one.

Record `league_id` and the replacement's `membership_id`.

---

## 5. The recovery itself

**Reuse the trusted primitive. Do not hand-edit roles.**

`transfer_league_administration()` vacates and fills in the one order the
partial unique index permits, re-checks that the recipient is an active player
of that league, and writes the audit event. Doing it by hand with two `UPDATE`s
risks violating the index, skipping the validation, and leaving no audit trail.

The function derives its actor from `auth.uid()`, so an operator connecting
directly is nobody and gets `AUTH_REQUIRED`. The supported way to drive it is to
run it **as the current administrator**, inside a transaction:

```sql
begin;

-- Act as the locked-out administrator. `auth.uid()` reads this claim.
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"<current-admin-user-id>","role":"authenticated"}';

select public.transfer_league_administration(
  '<league_id>',
  '<replacement_membership_id>',
  'Emergency recovery — ticket <ref>, authorised by <name>'
);

reset role;

-- REVIEW BEFORE COMMITTING.
select m.id, m.role, m.status, p.email_normalized
from public.league_memberships m
join public.profiles p on p.id = m.user_id
where m.league_id = '<league_id>'
order by m.role;

-- Expected: the replacement is now league_admin/active, the previous
-- administrator is player/active, and nobody else changed.
commit;   -- or: rollback;
```

`set local` is scoped to the transaction, so the impersonation ends at `COMMIT`
or `ROLLBACK` either way.

The reason string is **required in practice even though the parameter is
optional** — it is the only free-text record of why administration moved.

### Why impersonation rather than a bypass

It keeps every check the ordinary path applies: the recipient must be an active
player of that same league, the previous administrator is demoted rather than
duplicated, the deferred constraint still asserts exactly one active
administrator at `COMMIT`, and the audit event is written by the same code as
every normal transfer. A dedicated "operator override" function would be a
second, less-tested path to the most privileged operation in the product.

---

## 6. Audit evidence

The transaction writes three rows to `audit_events`, verified:

| `action` | Meaning |
|---|---|
| `league.administration_transferred` | Carries the `reason` string you supplied |
| `membership.role_changed` | The previous administrator → `player` |
| `membership.role_changed` | The replacement → `league_admin` |

Confirm after committing:

```sql
select created_at, action, actor_user_id, reason
from public.audit_events
where league_id = '<league_id>'
  and action in ('league.administration_transferred', 'membership.role_changed')
order by created_at desc
limit 5;
```

Note that `actor_user_id` is the **locked-out administrator**, because that is
whose session the function ran as. The database cannot record the operator's
identity here, so the ticket reference in the `reason` string is what ties the
row to a human. **Keep the ticket**: without it the audit trail says the
departed administrator transferred their own league, which is exactly what it
would say if nothing unusual had happened.

Retain alongside the ticket: who asked, how their authority was established, the
`SELECT` output from §4, and who reviewed before commit.

---

## 7. Post-recovery verification

1. **The invariant holds.** Expect exactly one row:

   ```sql
   select count(*) from public.league_memberships
   where league_id = '<league_id>'
     and role = 'league_admin' and status = 'active';
   ```

2. **The new administrator can actually administer.** Ask them to sign in and
   open `/leagues/<slug>/members`. Reaching it proves the server-side guard
   agrees, not just the table.

3. **The previous administrator is an ordinary player** — still a member, still
   able to sign up for matches. Recovery transfers administration; it does not
   remove anybody.

4. **Nothing else moved.** No match, roster, team or attendance record is touched
   by a transfer.

---

## 8. Rollback and escalation

**Rolling back** is the same procedure in reverse, run as the *new*
administrator, with a reason naming the original ticket. There is no undo —
`audit_events` is append-only, so both transfers stay on the record, which is
the correct outcome.

**Before committing**, `rollback;` is always safe: nothing has changed.

**Escalate rather than proceeding** when:

- more than one `league_admin` row is active, or none is — the constraint should
  make both impossible, so either means something is wrong beneath this
  procedure. Do not "fix" it with an `UPDATE`;
- the replacement is not an active player and somebody asks you to activate them
  first — that is a membership change the league's administration should make,
  and doing both in one sitting removes the check that the recipient really
  belongs to the league;
- the requester's authority cannot be established;
- the account was compromised. Rotate credentials and review recent
  `audit_events` for that league before deciding who should hold it.

---

## 9. The post-MVP fix

This procedure exists because of a deliberate MVP constraint. `04 §"Recommended"`
records the decision: normal transfer is in-app, and recovery is an operational
process rather than a second administrator role.

Supporting multiple administrators per league is on the post-MVP backlog
(`03 §12`) and would remove the need for this document entirely. Until then,
encourage every league to transfer administration *before* somebody leaves.

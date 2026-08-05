# Product Decisions and Remaining Questions — Matchday

## 1. Resolved decisions

### Product scope

- The product is not limited to RMVFC.
- Multi-league tenancy is part of the MVP foundation.
- One player can belong to multiple leagues.

### League visibility

- Private by default.
- Administrator can change a league to searchable.
- Players can request to join a searchable league.

### Roles

- Two league roles in the MVP: `league_admin` and `player`.
- Exactly one administrator per league.
- Administration must be transferable.

### Capacity and match format

- Capacity is configurable.
- RMVFC defaults to 22.
- Other leagues can configure 10 for 5v5 or another value.
- Minimum-player threshold is configurable.

### Signup

- Support first-come immediate confirmation.
- Support administrator-approved selection.
- League default may be overridden per match.

### Waitlist

- League chooses automatic or administrator-controlled promotion.
- Match may override the default.

### Deadlines

- Signup deadline, priority window, cancellation cutoff, and roster-publication target are configurable.
- League defaults may be overridden per match.

### Match states

- Show open, needs players, enough players, full, roster finalized, canceled, and completed states.

### Roster visibility

- Active league members can see the full confirmed roster.
- Players see only their own waitlist position.

### Player profile

- Name and email required.
- Phone, position, goalkeeper willingness, gender, and photo optional.
- No skill-level field.

### Teams

- Administrator creates teams.
- Randomize action available.
- Teams remain private until published.
- Data model supports more than two teams; UI defaults to two.

### Attendance

- Record attendance and no-shows.
- Show warnings to administrator.
- Do not automatically suspend or remove players.

### Cancellations

- Player can cancel at any time.
- Late cancellation is flagged and alerts the administrator.

### Manual additions

- Administrator may manually add an active member to a roster or waitlist.

### Guest workflow

- Dedicated sponsor/guest workflow is deferred.
- League administrator can manage eligibility through membership approval and notes during MVP.

## 2. Resolved 2026-08-03 — what “app notification” means

> **Decision: Option B.** The eventual product supports an in-app notification
> centre **plus** operating-system notifications delivered through Web Push.
> The in-app centre remains the source of truth; Web Push is a delivery channel
> layered on top of it.
>
> **Implemented in Phase 3 (2026-08-05).** Both halves shipped together: the
> canonical in-app notification centre *and* opt-in Web Push phone
> notifications. Web Push is no longer future work or an open option anywhere
> in this repository.
>
> Full record: [`docs/decisions/0001-notifications-in-app-center-plus-web-push.md`](../decisions/0001-notifications-in-app-center-plus-web-push.md).

The options that were under consideration:

**A. In-app notification inbox only**

- Notification appears when the user opens the web app.
- Lowest complexity.
- Does not proactively alert someone whose app is closed.

**B. In-app inbox plus Web Push**

- Can appear as a phone or desktop notification after permission is granted.
- Requires service worker, push subscription storage, permission UX, browser/device testing, and delivery infrastructure.
- On iPhone, users generally need the PWA installed before web push is useful.

**Outcome:** Option B was chosen and is now built. The in-app inbox is the
source of truth (`public.notifications`); Web Push delivers copies of those
records to opted-in devices and can fail without affecting them. Email remains
limited to authentication, and no email or SMS notification channel exists.

## 3. Non-blocking defaults unless changed

### Who can create a league?

**Recommended:** Any authenticated, email-verified user can create a league and becomes its administrator. Add abuse limits later.

### What appears in searchable-league results?

**Recommended:** League name, general area, sport/format, typical schedule, short description, and a request-to-join button. Do not show member names, roster, exact private location, gender data, or attendance information.

### How should `Randomize teams` work?

**Recommended:** Equal-size random assignment only. Show position, goalkeeper, and gender information so the administrator can adjust manually. Do not call it balanced.

### What happens if the sole administrator loses access?

**Recommended:** Normal ownership transfer is available in-app. Account-recovery or support-assisted transfer is documented as an operational process rather than built as a second administrator role in MVP.

### How long are notifications retained?

**Recommended:** Keep them for 90 days in the default UI, with older records archived or paginated rather than immediately deleted.

### Can a league require optional profile fields?

**Recommended:** Yes. A league can require position, goalkeeper willingness, or gender before match signup, while the global account requires only name and email.

## 4. Working name

`Matchday` is the generic working name. RMVFC is the initial pilot league, not the product name. Branding can be changed before launch.

# MVP Roadmap — Matchday

## 1. Roadmap principles

- Build secure multi-league tenancy from the first migration.
- Deliver one working vertical slice per phase.
- Do not ask Claude Code to implement the entire roadmap in one session.
- Each phase must end with lint, type-check, tests, build, and a file-by-file summary.
- Keep the notification domain channel-independent until the push-notification decision is final.
- Pilot with RMVFC while keeping configuration generic.

## 2. Estimated delivery range

For one developer using Claude Code:

- **Focused/full-time:** approximately 5–8 weeks
- **Part-time:** approximately 9–14 weeks

The largest variables are multi-tenant authorization, notification delivery choice, team-builder UX, and pilot feedback.

## 3. Phase 0 — Product lock and project setup

### Objective

Resolve the remaining notification decision and establish the repository and security baseline.

### Decisions to finalize

- In-app inbox only versus operating-system Web Push
- Public fields shown for searchable leagues
- Whether any verified user may create a league
- Ownership-recovery procedure if the sole administrator loses access
- Whether randomization is count-only for MVP

### Deliverables

- Next.js/TypeScript repository
- Tailwind and accessible UI primitives
- Supabase project and local workflow
- Environment variable template
- Test runner
- CI for lint, type-check, tests, and build
- Product documents under `/docs/product/`
- `TODO.md` and `NEXT_STEPS.md`

### Exit criteria

- App starts locally.
- CI is green.
- No secrets are committed.
- Notification scope is documented.

## 4. Phase 1 — Authentication, profiles, and tenant foundation

### Objective

Create the secure foundation for one account to belong to multiple leagues.

### Scope

- Supabase Auth magic link or one-time code
- Global profiles
- Optional gender, positions, goalkeeper willingness, phone, and photo fields
- Leagues table
- League memberships
- Exactly one administrator per league
- Private/searchable visibility field
- Active league selection and league switcher shell
- Tenant-aware RLS
- Audit-event foundation
- Development seed with two leagues and one multi-league player

### Deliverables

- Migrations and constraints
- Auth pages/callback
- Profile onboarding
- League switcher shell
- Authorization utilities
- RLS and tenancy tests
- Seed and local setup documentation

### Acceptance gate

- User signs in and completes a global profile.
- User can hold memberships in two leagues.
- League A data is inaccessible from League B context.
- One active administrator constraint is enforced.
- No skill-level field exists.

### Claude instruction

Stop after Phase 1. Run all validation and provide a file-by-file summary before proposing Phase 2.

## 5. Phase 2 — League creation, invitations, discovery, and join requests

### Objective

Let administrators create leagues and players enter through private or searchable workflows.

### Scope

- Create-league flow
- Private by default
- Editable searchable visibility
- Limited public league-search projection
- Join requests and decisions
- Revocable invitation links
- Manual member addition by email
- Administrator transfer
- League settings screen

### Acceptance gate

- Private leagues never appear in search.
- Searchable league join request can be approved or rejected.
- Approval creates one active membership.
- Administrator transfer is atomic.

## 6. Phase 3 — Guidelines, match templates, publication, and app notifications

### Objective

Allow a league to publish configurable matches and notify members inside the app.

### Scope

- Versioned league guidelines and acknowledgement
- Match templates
- Configurable capacity and minimum threshold
- Selection and waitlist modes
- Configurable deadlines and team count
- Draft/open/canceled states
- In-app notification records and inbox
- Match cards and detail pages
- Recurring template defaults

### Acceptance gate

- Draft is invisible to players.
- Published match creates exactly one notification per eligible member.
- Required league guidelines block signup only in that league.
- Threshold labels are correct.

## 7. Phase 4 — Signup, roster, and waitlist modes

### Objective

Support both major league signup workflows.

### Scope

- First-come immediate confirmation
- Administrator-approved pending requests
- Capacity transactions
- Ordered waitlist
- Automatic and administrator-controlled promotion modes
- Full confirmed-roster visibility
- Manual administrator roster additions
- Roster publication and revisions

### Acceptance gate

- Concurrent requests never exceed capacity.
- First-come mode confirms or waitlists immediately.
- Approval mode remains pending until administrator action.
- Waitlist positions are unique and stable.
- Players see the full confirmed roster but only their own waitlist position.

## 8. Phase 5 — Cancellations, reminders, and replacement handling

### Objective

Make post-signup changes reliable and low effort.

### Scope

- Player cancellation
- On-time versus late classification
- Automatic promotion transaction
- Administrator-controlled promotion workflow
- Cancellation, promotion, roster-change, and reminder notifications
- Notification read/unread/archive behavior

### Acceptance gate

- Cancellation immediately frees capacity.
- One open spot promotes at most one player.
- Late cancellations notify the administrator.
- Notification events are idempotent.

## 9. Phase 6 — Team builder and publication

### Objective

Let the administrator assign and publish teams without external spreadsheets or messages.

### Scope

- Two or more teams
- Manual drag/select assignment
- Equal-size count-based randomization
- Position, goalkeeper, and gender indicators
- Draft teams
- Publish teams
- Player team view
- Team-change notifications

### Acceptance gate

- Every confirmed player is assigned at most once.
- Randomization assigns every confirmed player and keeps team sizes within one.
- Draft teams are invisible to players.
- Published teams are visible to confirmed players.

## 10. Phase 7 — Attendance, no-show warnings, and pilot polish

### Objective

Complete the match lifecycle and prepare for the RMVFC pilot.

### Scope

- Attendance entry
- On-time cancellation, late cancellation, excused, and no-show outcomes
- No-show warnings
- Manual suspension/removal with reason
- Attendance correction and audit history
- Mobile usability and accessibility pass
- Loading, empty, and error states
- PWA manifest
- Monitoring and production setup

### Pilot plan

1. Create RMVFC as a private league with 22 capacity and 11v11 settings.
2. Enter the Monday and Wednesday templates.
3. Configure administrator-approval selection and administrator-controlled waitlist promotion.
4. Import or invite a small test group.
5. Run a rehearsal match.
6. Run four real matches, including team publication and attendance.
7. Interview the administrator and at least five players.

### Pilot success gate

- App is the source of truth for four matches.
- Most players complete signup without assistance.
- One cancellation and promotion flow succeeds.
- Teams are published through the app.
- No critical authorization or capacity defect occurs.

## 11. MVP completion checklist

### Product

- [ ] Multi-league account and switcher
- [ ] Private/searchable league settings
- [ ] Join requests and invitations
- [ ] One administrator per league and transfer
- [ ] Versioned guidelines
- [ ] Match templates and configurable matches
- [ ] First-come and administrator-approved signup
- [ ] Automatic and administrator-controlled waitlists
- [ ] Full confirmed roster visibility
- [ ] In-app notifications
- [ ] Cancellation and replacement
- [ ] Multi-team builder and publication
- [ ] Attendance and no-show warnings

### Security

- [ ] Tenant-aware RLS reviewed
- [ ] Server admin authorization tested
- [ ] No service keys exposed
- [ ] Public search projection reviewed
- [ ] Gender, attendance, and disciplinary data excluded from public/player payloads
- [ ] Invite tokens secured and revocable

### Quality

- [ ] Lint passes
- [ ] Type-check passes
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] RLS isolation tests pass
- [ ] Playwright flows pass
- [ ] Concurrent capacity and promotion tests pass
- [ ] Timezone/deadline tests pass

### Operations

- [ ] Notification failures observable
- [ ] Administrator recovery process documented
- [ ] Production secrets configured
- [ ] Backup posture understood
- [ ] Monitoring enabled
- [ ] Support contact shown

## 12. Post-MVP backlog

- Native iOS and Android apps
- Web Push, when not included in MVP
- Email or SMS delivery channels
- Billing and paid league plans
- Additional administrators and granular staff roles
- Guest sponsorship workflow
- Automated position/gender-aware team suggestions
- Skill ratings or competitive balance assistance
- Calendar subscriptions
- Weather cancellation workflow
- Payments and dues
- Standings, tournaments, and season statistics
- Public games marketplace
- Import members from CSV
- League analytics

## 13. Recommended first Claude Code request

Implement **Phase 1 only**: project setup, authentication, global profiles, leagues, one-admin memberships, private/searchable setting, league-switcher shell, tenant-aware RLS, seed data, and automated authorization tests. Stop before league creation UI, join requests, matches, notifications, or signup.

# Feature Specifications — Matchday

## 1. Purpose

This document converts the product requirements into implementation-oriented behavior, data, authorization, acceptance criteria, and test requirements. It is written for use with Claude Code and human review.

## 2. Proposed architecture

### Frontend

- Next.js with strict TypeScript
- Mobile-first responsive UI
- Tailwind CSS
- Accessible component primitives
- PWA manifest after the core web flows are stable
- League switcher available throughout authenticated pages

### Backend

- Next.js server actions or route handlers
- Supabase Postgres as system of record
- Supabase Auth using email magic link or one-time code
- Tenant-aware Row Level Security
- Server-side authorization for all mutations
- Scheduled jobs for reminders and recurring match generation
- Channel-independent notification event service

### Testing

- Unit tests for rules and date calculations
- Integration tests for database and transactional behavior
- RLS tests for cross-league isolation
- Component tests for major UI states
- Playwright tests for player and administrator journeys

### Deployment

- Vercel
- Hosted Supabase
- Separate development, preview, and production environments

## 3. Domain states and enums

### League visibility

```text
private
searchable
```

### League role

```text
league_admin
player
```

The MVP permits exactly one active `league_admin` membership per league.

### Membership status

```text
pending
active
suspended
removed
```

### Join request status

```text
pending
approved
rejected
withdrawn
```

### Selection mode

```text
first_come
admin_approval
```

### Waitlist promotion mode

```text
automatic
admin_controlled
```

### Match lifecycle status

```text
draft
open
roster_finalized
teams_published
canceled
completed
```

The following labels are derived rather than stored as lifecycle states:

```text
needs_players
enough_players
full
```

### Signup status

```text
interested
confirmed
waitlisted
not_selected
not_available
canceled
withdrawn_late
```

### Attendance outcome

```text
attended
excused_absence
canceled_on_time
canceled_late
no_show
```

### Notification status

```text
unread
read
archived
```

## 4. Role and permission matrix

| Capability | Pending applicant | Player | League administrator |
|---|---:|---:|---:|
| View limited searchable-league profile | Yes | Yes | Yes |
| Request to join searchable league | Yes | Yes | Yes |
| View member-only league content | No | Yes | Yes |
| Join/cancel own match spot | No | Yes | Yes |
| View confirmed roster | No | Yes | Yes |
| View published teams | No | Confirmed players | Yes |
| Create/publish matches | No | No | Yes |
| Manage roster and waitlist | No | No | Yes |
| Create/publish teams | No | No | Yes |
| Record attendance | No | No | Yes |
| Approve join requests | No | No | Yes |
| Edit league settings | No | No | Yes |
| Transfer administration | No | No | Yes |
| View audit log | No | No | Yes |

## 5. Feature F-01 — Authentication and global profile

### User story

As a player, I want one account that works across every league I join.

### Required profile fields

- First name
- Last name
- Normalized email

### Optional profile fields

- Phone
- Gender
- Preferred positions
- Goalkeeper willingness
- Profile photo URL

No skill-level or skill-rating field exists in the MVP.

### Behavior

1. User signs in through email magic link or one-time code.
2. First sign-in creates one global profile.
3. Profile data is reused across league memberships.
4. A league may require selected optional fields before match signup.
5. User can edit their own profile except verified identity fields controlled by the server.

### Acceptance criteria

- Duplicate email capitalization does not create duplicate profiles.
- A user can belong to multiple leagues.
- Profile edits do not grant league roles.
- Private optional fields are not included in public league-search responses.

## 6. Feature F-02 — League creation, settings, and administration

### Create league

Any authenticated user may create a league unless platform-level abuse limits block the action. The creator becomes the league's sole administrator.

### Required league fields

- Name
- Slug
- General area
- Timezone
- Sport label
- Short description
- Visibility
- Default capacity
- Default minimum-player threshold
- Default selection mode
- Default waitlist-promotion mode

### Optional league fields

- Logo
- Typical schedule
- Default location
- Default team count
- Position labels
- Gender field enabled
- Goalkeeper field enabled
- Public contact method

### Behavior

- New leagues default to `private`.
- Administrator may switch to `searchable`.
- Searchable-league results expose only the approved public projection.
- Exactly one active administrator is enforced by database constraints and transfer workflow.
- Administrator can transfer the role to one active player membership.
- Transfer is atomic: the recipient becomes administrator and the previous administrator becomes player.

### Acceptance criteria

- A league cannot have zero or two active administrators after a successful transaction.
- A player cannot modify league settings through direct API calls.
- A private league is absent from public search.
- Changing visibility creates an audit event.

## 7. Feature F-03 — League discovery, invitations, and membership

### Private league flow

- Administrator creates a revocable invitation link.
- Signed-in user opens link and joins or requests membership according to the invite configuration.
- Invite token is hashed or otherwise stored securely.
- Invite may have an expiration and usage limit.

### Searchable league flow

- User searches by league name or area.
- Result displays name, general area, sport label, typical schedule, and short description.
- User submits one pending join request.
- Administrator receives a notification.
- Administrator approves or rejects.

### Membership behavior

- A profile may have one membership per league.
- Membership is active, pending, suspended, or removed.
- Administrator can manually add an existing account by email.
- Guest-specific sponsor logic is deferred. League-specific eligibility notes may be stored by the administrator.

### Acceptance criteria

- Duplicate pending join requests are prevented.
- Rejected users may not access member-only data.
- Approval creates or activates exactly one membership.
- Cross-league membership data is isolated.

## 8. Feature F-04 — Guidelines and acknowledgement

### Data

- League ID
- Version identifier
- Title
- Full body or uploaded-document reference
- Effective date
- Requires acceptance
- Published and archived timestamps
- Content checksum

### Behavior

- Each league manages its own guideline versions.
- Required acceptance is explicit and never prechecked.
- A new required version blocks match signup for that league only.
- Historical acknowledgements are immutable.

### Acceptance criteria

- A player may be eligible in one league and blocked in another because of different guideline status.
- Public users cannot view private guideline versions unless the league chooses to publish them.
- Administrator can audit acknowledgements.

## 9. Feature F-05 — Match templates and match creation

### Template fields

- League ID
- Name
- Day-of-week or recurrence metadata
- Arrival, kickoff, and end times
- Location
- Capacity
- Minimum-player threshold
- Selection mode
- Waitlist-promotion mode
- Signup close rule
- Priority-window duration, optional
- Cancellation cutoff rule
- Target roster-publication rule
- Default team count
- Reminder schedule

### Match fields

- League ID
- Template ID, optional
- Title
- Date and timezone
- Arrival, kickoff, and end timestamps
- Location name and optional map URL
- Capacity
- Minimum-player threshold
- Selection mode
- Waitlist-promotion mode
- Priority-window end, optional
- Signup close timestamp
- Cancellation cutoff timestamp
- Target roster-publication timestamp
- Team count
- Lifecycle status
- Public notes
- Administrator notes

### Derived state

- `needs_players` when confirmed/interested count relevant to the mode is below minimum threshold
- `enough_players` when threshold is met and capacity remains
- `full` when confirmed count equals capacity

### Behavior

- Administrator creates from a template or scratch.
- All defaults are editable before publication.
- Published match changes may create player notifications.
- Canceling a match notifies interested, confirmed, and waitlisted players.

### Acceptance criteria

- Capacity is a positive integer.
- Minimum threshold is between zero and capacity.
- Drafts are invisible to players.
- Publication is idempotent.
- Time calculations respect league timezone and daylight-saving transitions.

## 10. Feature F-06 — Signup and first-come confirmation

### Player actions

- `Join match`
- `Can't play`
- `Cancel my spot`

### First-come behavior

1. Eligible player taps `Join match`.
2. Server locks or transactionally evaluates current confirmed capacity.
3. If capacity remains, status becomes `confirmed`.
4. If full, status becomes `waitlisted` with the next sequential position.
5. Result notification is created.

### Eligibility checks

- Active league membership
- Required guideline acknowledgement
- Match is open
- Signup deadline has not passed, unless administrator override
- No duplicate signup

### Acceptance criteria

- Concurrent joins cannot exceed capacity.
- Multiple taps are idempotent.
- Waitlist positions are unique and sequential.
- A confirmed roster is immediately visible to league members.

## 11. Feature F-07 — Administrator-approved signup and roster workspace

### Player behavior

- Player selects `Request a spot`.
- Signup status becomes `interested`.
- UI explicitly says the spot is not yet confirmed.

### Administrator workspace fields

- Player name
- Response time
- Optional priority-window qualification
- Recent attendance count
- No-show warning
- Preferred positions
- Goalkeeper willingness
- Gender, when enabled
- Current decision
- Administrator notes

Do not display or calculate a skill rating.

### Administrator actions

- Confirm player
- Move player to waitlist
- Mark not selected
- Reorder waitlist
- Manually add an active league member
- Publish/finalize roster

### Behavior

- Capacity cannot be exceeded accidentally.
- Optional priority rules create warnings, not universal automatic entitlement.
- Finalization creates one outcome notification per affected player.
- Later changes create a roster revision and audit event.

### Acceptance criteria

- Finalization is idempotent.
- Every responding player has one clear outcome.
- Full confirmed roster is visible to members after publication.
- Private attendance and no-show context is not visible to players.

## 12. Feature F-08 — Roster and waitlist visibility

### Player view

- Full confirmed roster names after confirmation/finalization
- Their own current status
- Their own waitlist position
- Open spot count when league setting permits
- No private waitlist list
- No attendance, gender, phone, or no-show details for other players

### Administrator view

- Full confirmed roster
- Ordered waitlist
- Pending/interested requests
- Declined and canceled players
- Open spots
- Minimum-threshold state
- Position and goalkeeper summary

### Acceptance criteria

- Roster updates are atomic with signup changes.
- Players cannot infer hidden waitlist or disciplinary data through API payloads.

## 13. Feature F-09 — Cancellation and waitlist promotion

### Cancellation behavior

1. Player selects `Cancel my spot`.
2. App displays cutoff and labels the cancellation on-time or late.
3. Server records timestamp and optional reason.
4. Canceled player stops consuming capacity.
5. Late cancellation creates an administrator notification.

### Automatic promotion

- First eligible waitlisted player is promoted in the same transaction that releases the spot, or in an idempotent follow-up transaction protected from duplicate promotion.
- Remaining positions close the gap.
- Promoted player receives a notification.

### Administrator-controlled promotion

- Administrator receives a notification and recommended next player.
- Administrator may promote a different eligible player with an audit note.

### Acceptance criteria

- A single opened spot cannot promote two players.
- Automatic mode requires no administrator action.
- Administrator-controlled mode never promotes silently.
- Late cancellation is not automatically converted to a no-show.

## 14. Feature F-10 — In-app notification center

### Required notification types

- League invitation accepted
- Join request submitted
- Join request approved or rejected
- Match published
- Signup confirmed
- Signup pending
- Waitlisted
- Not selected
- Cancellation receipt
- Late-cancellation administrator alert
- Waitlist promotion
- Roster published or changed
- Match changed
- Match canceled
- Reminder
- Teams published or changed
- Attendance/no-show status recorded

### Notification record

- ID
- Recipient user ID
- League ID
- Match ID, optional
- Type
- Title
- Body
- Deep-link route
- Read status
- Created timestamp
- Read timestamp
- Idempotency key
- Optional delivery-channel metadata

### Behavior

- Authenticated header or navigation shows unread count.
- Notification center supports mark read, mark unread, and archive.
- Deep links verify membership before displaying the target.
- Domain events create notifications idempotently.
- The schema must allow future Web Push or email delivery without duplicating domain logic.

### Acceptance criteria

- A user sees only their notifications.
- Refreshing a mutation does not create duplicate notifications.
- Removing a user's league membership blocks access to old member-only deep links.

## 15. Feature F-11 — Team builder and publication

### Team model

- A match may have two or more teams.
- Each team has a name and optional shirt/color label.
- Only confirmed players may be assigned.
- A player may have at most one team assignment per match.

### Administrator behavior

- Create, rename, and delete draft teams while preserving valid assignments.
- Drag or select players between teams.
- See team size, positions, goalkeeper volunteers, and gender distribution.
- Use `Randomize teams` to distribute players as evenly as possible by count.
- Save draft assignments.
- Publish teams explicitly.

### Player behavior

- Draft teams are invisible.
- After publication, confirmed players see every published team and their own assignment.
- Team changes after publication create notifications.

### Acceptance criteria

- Randomization assigns every confirmed player exactly once.
- Team sizes differ by no more than one when mathematically possible.
- Randomization does not claim competitive balance.
- Publishing teams is idempotent and audited.

## 16. Feature F-12 — Attendance and no-show warnings

### Outcomes

- Attended
- Excused absence
- Canceled on time
- Canceled late
- No-show

### Behavior

- Administrator records attendance after the match.
- History is stored per league membership.
- No-show entries create visible administrator warnings for future roster decisions.
- No automatic suspension or removal occurs in MVP.
- Administrator may manually set membership to suspended or removed with a reason and optional end date.
- Corrections retain audit history.

### Acceptance criteria

- One attendance record exists per confirmed player and match.
- Players can view their own attendance outcome.
- Other players cannot view attendance or no-show history.
- Reversals do not delete historical audit events.

## 17. Data model

Names are conceptual. Claude may refine column names while preserving behavior.

### `profiles`

- `id` UUID matching auth identity
- `first_name`
- `last_name`
- `email_normalized`
- `phone` nullable
- `gender` nullable
- `preferred_positions` JSON or join table
- `goalkeeper_willing` nullable boolean
- `profile_photo_url` nullable
- timestamps

### `leagues`

- `id`
- `name`
- `slug`
- `general_area`
- `timezone`
- `sport_label`
- `description`
- `visibility`
- `default_capacity`
- `default_min_players`
- `default_selection_mode`
- `default_waitlist_mode`
- `default_team_count`
- `settings_json`
- timestamps

### `league_memberships`

- `id`
- `league_id`
- `user_id`
- `role` — league_admin or player
- `status`
- `eligibility_notes`
- `suspended_until` nullable
- timestamps
- unique `(league_id, user_id)`
- partial unique constraint enforcing one active administrator per league

### `league_join_requests`

- `id`
- `league_id`
- `user_id`
- `status`
- `message` nullable
- decision metadata
- unique active pending request per league and user

### `league_invites`

- `id`
- `league_id`
- token hash
- expiration
- usage limit/count
- revoked timestamp
- created by

### `guideline_versions`

- league-scoped fields from F-04

### `guideline_acceptances`

- `league_id`
- `membership_id`
- guideline version
- accepted timestamp
- unique membership and version

### `match_templates`

- league-scoped defaults from F-05

### `matches`

- league-scoped fields from F-05
- roster revision
- team revision
- created by
- timestamps

### `match_signups`

- `id`
- `league_id`
- `match_id`
- `membership_id`
- `status`
- response timestamp
- priority qualified nullable
- waitlist position nullable
- cancellation timestamp/reason
- selected by/at
- override reason
- unique `(match_id, membership_id)`

### `match_teams`

- `id`
- `league_id`
- `match_id`
- name
- label nullable
- display order
- published revision metadata

### `match_team_assignments`

- `match_id`
- `team_id`
- `membership_id`
- assigned by
- assigned at
- unique `(match_id, membership_id)`

### `attendance_records`

- `league_id`
- `match_id`
- `membership_id`
- outcome
- note
- recorded by/at
- unique `(match_id, membership_id)`

### `notifications`

- fields from F-10

### `audit_events`

- `id`
- `league_id`
- actor user ID
- entity type and ID
- action
- before/after JSON
- reason
- created timestamp

## 18. Server operation surface

### Account operations

- `getMyProfile()`
- `updateMyProfile(input)`
- `getMyLeagues()`
- `setActiveLeague(leagueId)`

### League operations

- `createLeague(input)`
- `updateLeague(leagueId, input)`
- `searchLeagues(query)`
- `createLeagueInvite(leagueId, input)`
- `joinLeagueByInvite(token)`
- `requestToJoinLeague(leagueId, message?)`
- `approveJoinRequest(requestId)`
- `rejectJoinRequest(requestId)`
- `transferLeagueAdministration(leagueId, targetMembershipId)`

### Match/player operations

- `getUpcomingMatches(leagueId)`
- `getMatch(matchId)`
- `joinMatch(matchId)`
- `requestSpot(matchId)`
- `markUnavailable(matchId)`
- `cancelSpot(matchId, reason?)`
- `getPublishedRoster(matchId)`
- `getPublishedTeams(matchId)`

### Administrator operations

- `createMatch(input)`
- `updateMatch(matchId, input)`
- `publishMatch(matchId)`
- `cancelMatch(matchId, reason)`
- `setSignupDecision(matchId, membershipId, status, reason?)`
- `reorderWaitlist(matchId, orderedMembershipIds)`
- `finalizeRoster(matchId)`
- `promoteWaitlistedPlayer(matchId, membershipId)`
- `addMemberToMatch(matchId, membershipId, status)`
- `createTeam(matchId, input)`
- `assignPlayerToTeam(matchId, teamId, membershipId)`
- `randomizeTeams(matchId)`
- `publishTeams(matchId)`
- `recordAttendance(matchId, records)`
- `updateMembershipStatus(membershipId, input)`

### Notification operations

- `getMyNotifications(cursor?)`
- `markNotificationRead(notificationId)`
- `markNotificationUnread(notificationId)`
- `archiveNotification(notificationId)`

### Authorization rule

Every operation derives the current actor from the authenticated server session. Client input never supplies a trusted actor ID, league role, or league scope.

## 19. Database and transactional requirements

- One membership per user and league
- Exactly one active administrator per league
- One signup per player and match
- One team assignment per player and match
- One attendance record per player and match
- Unique sequential waitlist positions
- Capacity enforcement inside a transaction or protected database function
- Cancellation and automatic promotion are transactionally safe
- Administrator transfer is atomic
- Notification creation uses idempotency keys
- Audit event created for every administrator mutation
- Historical records are archived, not silently deleted

## 20. Row Level Security expectations

### Global profile

- User reads and updates their own profile through controlled fields.
- League administrators may read only profile fields needed for active members in their own league.

### League data

- Active members read member-visible rows for their league.
- Pending applicants read only the limited league projection and their own join request.
- Administrator writes require server authorization and league-admin membership.
- A member of League A cannot infer League B's membership, roster, notification, attendance, or audit data.

### Public search

Use a view or server endpoint that returns only the intentionally public projection for searchable leagues.

## 21. Stable domain error codes

```text
AUTH_REQUIRED
PROFILE_INCOMPLETE
LEAGUE_NOT_FOUND
LEAGUE_PRIVATE
MEMBERSHIP_REQUIRED
MEMBERSHIP_INACTIVE
JOIN_REQUEST_EXISTS
NOT_LEAGUE_ADMIN
ADMIN_TRANSFER_INVALID
GUIDELINES_NOT_ACCEPTED
MATCH_NOT_OPEN
SIGNUP_CLOSED
CAPACITY_EXCEEDED
WAITLIST_CONFLICT
ALREADY_CONFIRMED
ALREADY_FINALIZED
TEAM_ASSIGNMENT_INVALID
NOTIFICATION_NOT_FOUND
NOT_AUTHORIZED
```

## 22. Observability

- Structured logs without secrets or private profile data
- Error monitoring
- Scheduled-job health
- Notification creation failures
- Audit trail for administrator changes
- Product events: league created, join requested, match published, signup completed, roster finalized, cancellation, promotion, teams published, attendance completed

## 23. Test plan

### Unit tests

- Derived match threshold states
- Signup eligibility
- First-come capacity handling
- Priority-window calculation
- Waitlist ordering
- Cancellation cutoff classification
- Equal-size team randomization
- Guideline re-acceptance
- Timezone calculations

### Integration tests

- One administrator constraint and transfer
- Private versus searchable visibility
- Join request approval
- Cross-league data isolation
- Concurrent requests for final confirmed spot
- Automatic promotion after cancellation
- Administrator-controlled promotion
- Roster finalization and notification creation
- Team publication
- Attendance correction and audit history

### Component tests

- League switcher
- Searchable league card
- Match status states
- Admin roster workspace
- Waitlist mode indicators
- Notification center
- Team builder
- Late cancellation warning

### End-to-end tests

1. User creates a private league and invites a player.
2. Administrator makes league searchable; another user requests to join and is approved.
3. One player belongs to two leagues and switches between them without data leakage.
4. First-come match confirms players up to capacity and waitlists the next player.
5. Administrator-approved match remains pending until roster publication.
6. Confirmed player cancels and automatic promotion fills the spot exactly once.
7. Administrator randomizes, edits, and publishes two teams.
8. Administrator records a no-show; warning appears without automatic suspension.

## 24. Definition of done

- Behavior matches this specification or an approved decision record.
- Server authorization and RLS both enforce league isolation.
- Database migration and rollback-safe forward strategy are documented.
- Success, permission failure, concurrency, and major edge cases are tested.
- Notifications are idempotent.
- Administrator mutations are audited.
- No secrets, gender data, attendance history, or disciplinary data are logged or publicly exposed.
- README and environment documentation are updated.

# Product Requirements Document — Matchday

## 1. Document status

- **Status:** Draft v0.2
- **Working product name:** Matchday
- **Initial pilot league:** RMV Football Club
- **Product model:** Multi-league pickup-sports platform, initially optimized for soccer
- **Primary platform:** Mobile-first responsive web app, installable as a PWA
- **Source material:** RMV Football Club Guidelines for Play, last updated March 4, 2023

## 2. Executive summary

Matchday replaces informal email and group-message signup workflows with one application for creating pickup matches, collecting player availability, confirming rosters, managing waitlists, assigning teams, publishing updates, and recording attendance.

The first pilot is RMV Football Club, but the product must not be hard-coded for one club or one match format. A normal RMV match defaults to 22 players for 11 versus 11, while another league may configure a 10-player 5 versus 5 match or another capacity. Each league controls its own visibility, selection method, deadlines, waitlist behavior, roster settings, match format, and rules.

A player may belong to multiple leagues under one account. Each league has one administrator and any number of players. The administrator can create matches, manage membership requests, finalize rosters when required, assign and publish teams, and record attendance. Players can join leagues, request spots, view their status and confirmed roster, receive app notifications, cancel, and view published teams.

## 3. Problem statement

### Player problems

- Match invitations are easy to miss in email or group chats.
- Players cannot reliably tell whether they requested a spot, were confirmed, or are waitlisted.
- Cancellation deadlines, open spots, team assignments, and match updates are fragmented.
- Players who belong to multiple groups must follow separate informal workflows.
- League rules and participation expectations are not integrated into signup.

### Administrator problems

- The administrator repeatedly sends invitations and counts replies manually.
- Capacity, minimum turnout, waitlists, and replacements are tracked by hand.
- Different leagues use different selection and waitlist rules.
- Team creation and publication are handled in separate messages or spreadsheets.
- Attendance and no-show history are inconsistent or missing.
- There is no canonical, live source of truth for a match.

## 4. Product goals

### MVP goals

1. Let a player respond to a match in under 30 seconds.
2. Support multiple leagues and multiple memberships per player.
3. Let each league choose private or searchable visibility.
4. Support both first-come automatic confirmation and administrator-approved selection.
5. Support configurable capacity, minimum-player threshold, deadlines, and waitlist behavior.
6. Provide a clear confirmed roster and ordered waitlist.
7. Let the league administrator create, randomize, edit, and publish teams.
8. Deliver match and roster updates through an in-app notification center.
9. Record attendance and surface no-show warnings without automatically suspending players.
10. Protect every league's data with tenant-aware authorization and database policies.

### Secondary goals

- Support recurring match templates.
- Make public league discovery possible without exposing private member information.
- Allow manual administrator additions when a player responds outside the app.
- Preserve league-specific rules, guideline versions, and acknowledgement history.
- Keep the domain model flexible enough for more than two teams.

## 5. Non-goals for the first MVP

- Native iOS or Android applications
- Payments, dues, subscriptions, or SaaS billing
- Tournament brackets, standings, or season scheduling
- Live scoring or detailed player statistics
- In-app group chat or social feed
- Automated skill ratings or skill-based team balancing
- Fully automated discipline or suspension enforcement
- Complex guest-sponsorship workflows
- Public display of member lists, attendance history, gender, or disciplinary information
- Sports-specific logic beyond configurable teams, capacity, positions, and match details

## 6. Confirmed product decisions

### League access and tenancy

- New leagues are **private by default**.
- A league administrator may make a league searchable.
- Players may request to join a searchable league.
- The administrator approves or rejects join requests.
- One user account may belong to multiple leagues.
- Each league has exactly one `league_admin` in the MVP and any number of `player` members.
- Administrative ownership must be transferable so a league is not permanently tied to one account.

### Match capacity and format

- Capacity is configurable at the league-template and individual-match level.
- RMVFC defaults to 22 players.
- A 5 versus 5 league may default to 10 players.
- Each match may define a minimum-player threshold.
- The system displays whether a match needs players, has enough players, is full, is finalized, is canceled, or is completed.

### Selection modes

Each league chooses one default selection mode, overridable per match:

1. **First come:** Eligible players are immediately confirmed until capacity is reached; later players enter the waitlist.
2. **Administrator approval:** Players request spots; the administrator selects the confirmed roster and waitlist.

### Waitlist modes

Each league chooses one default waitlist-promotion mode, overridable per match:

1. **Automatic:** The first eligible waitlisted player is promoted when a confirmed spot opens.
2. **Administrator controlled:** The app recommends the next player, but the administrator confirms the promotion.

### Deadlines

- Signup deadline is configurable.
- Priority-response window is configurable and may be disabled.
- Cancellation deadline is configurable.
- Target roster-publication time is configurable.
- League defaults may be overridden for an individual match.

### Roster visibility

- League members can view the full confirmed roster after confirmation or finalization.
- Players cannot see the private waitlist order; a waitlisted player sees their own position.
- Public visitors and pending join requests cannot see rosters.

### Player profile

Required:

- First name
- Last name
- Email

Optional:

- Phone number
- Gender
- Preferred positions
- Goalkeeper willingness
- Profile photo

There is no skill-level or skill-rating field in the MVP.

### Teams

- The administrator creates and edits teams from confirmed players.
- The data model supports multiple teams.
- The interface defaults to two teams for a normal match.
- A `Randomize teams` action distributes confirmed players into equal-sized teams without claiming the teams are competitively balanced.
- Position, goalkeeper willingness, and gender are visible to the administrator while assigning teams.
- Team assignments remain private drafts until the administrator publishes them.
- Published teams become visible to confirmed players and create app notifications.

### Attendance and no-shows

- The administrator records attendance outcomes after a match.
- The app records no-show history and shows warnings to administrators.
- The app does not automatically suspend or remove players in the MVP.
- Administrators may manually change membership status when required by their league's rules.

### Cancellations

- Players can cancel their own spot at any time.
- The app clearly labels whether the cancellation is on time or late.
- Late cancellations alert the administrator and remain subject to administrator review.
- A canceled player no longer consumes a roster spot.

### Notifications

- The MVP includes an in-app notification center.
- Notification events include match publication, signup status, waitlist changes, roster publication, cancellation, promotion, match updates, team publication, reminders, and cancellation of a match.
- Whether “app notification” also means operating-system push notifications is still an open decision.
- Email remains necessary for authentication unless a different authentication method is selected later.

### Manual administrator actions

- The administrator can add an existing league member to a confirmed roster or waitlist.
- Every administrator roster, waitlist, team, attendance, and membership change is audited.

## 7. RMVFC pilot configuration

The supplied RMVFC guidelines define the initial pilot configuration, not universal product rules:

- Monday and Wednesday evening matches
- 11 versus 11 and a default capacity of 22
- Resident priority for responses received within a 24-hour invitation window
- Guests permitted with prior approval
- Participation consistency considered by the administrator when spots are limited
- Cancellation cutoff at 12:00 p.m. on the day before the match
- No-show policies managed by the club administrator
- Teams created by the administrator

The generic product must store these as league configuration, guideline content, or administrator context rather than hard-coded global logic.

## 8. Users and roles

### Platform user

A signed-in person with one global profile and zero or more league memberships.

### Player

A member of a league who can view published league information, view matches, request or claim spots, cancel, view rosters, view published teams, receive notifications, and view their own participation history.

### League administrator

The single administrative owner of a league in the MVP. This user can edit league settings, approve members, create matches, configure selection and waitlist behavior, manage rosters, assign teams, publish updates, record attendance, manage member status, and transfer administration.

### Pending applicant

A user who requested access to a searchable league but is not yet a member. They can see only limited public league information and their request status.

## 9. Core user journeys

### Journey A — Create a league

1. Signed-in user selects `Create a league`.
2. User enters league name, area, timezone, sport label, default match format, capacity, and visibility.
3. System creates the league with that user as its sole administrator.
4. Administrator configures selection mode, waitlist mode, deadlines, profile fields, and roster visibility.
5. Administrator receives an invite link for private distribution.

### Journey B — Join a private league

1. Player opens an invitation link.
2. Player signs in or creates an account.
3. Player completes required profile fields and accepts league guidelines.
4. Player joins as an active member or enters pending status, depending on league settings.

### Journey C — Find and request a searchable league

1. Player searches by league name or area.
2. Player views limited public league details.
3. Player submits a join request.
4. Administrator receives an app notification and approves or rejects the request.
5. Approved player completes any league-specific onboarding requirements.

### Journey D — Publish a match

1. Administrator creates a match from a template or from scratch.
2. Capacity, minimum threshold, selection mode, waitlist mode, deadlines, teams, and location are prefilled.
3. Administrator reviews and publishes the match.
4. Eligible members receive an app notification.
5. The match becomes visible on each member's home screen.

### Journey E — First-come signup

1. Player opens the match and taps `Join match`.
2. If capacity is available, the player is immediately confirmed.
3. If capacity is full, the player is waitlisted.
4. The roster count and player's status update atomically.

### Journey F — Administrator-approved signup

1. Player opens the match and taps `Request a spot`.
2. Player sees `Selection pending`.
3. Administrator reviews all requests and relevant league-specific context.
4. Administrator confirms players, orders the waitlist, and publishes the roster.
5. Players receive app notifications and can view the full confirmed roster.

### Journey G — Cancellation and replacement

1. Confirmed player selects `Cancel my spot`.
2. App displays whether the cancellation is late.
3. Cancellation immediately releases capacity.
4. Automatic leagues promote the first eligible waitlisted player transactionally.
5. Administrator-controlled leagues notify the administrator and recommend a player.
6. Affected users receive app notifications.

### Journey H — Build and publish teams

1. Administrator opens the team builder after a roster is confirmed.
2. Administrator creates two or more teams.
3. Administrator assigns players manually or uses `Randomize teams`.
4. Administrator adjusts assignments using position, gender, and goalkeeper information.
5. Teams remain private until `Publish teams` is selected.
6. Confirmed players receive a notification and can view their team.

### Journey I — Record attendance

1. After the match, administrator marks each confirmed player as attended, canceled on time, canceled late, excused, or no-show.
2. App updates participation history.
3. App shows no-show warnings but does not automatically suspend the player.
4. Administrator may manually update membership status with an audit note.

## 10. Functional requirements

### Account and membership

- One global account supports membership in multiple leagues.
- League data is isolated by `league_id`.
- A user can switch between leagues without signing in again.
- Private league membership uses invitation links or administrator addition.
- Searchable leagues support join requests and administrator decisions.
- A league has exactly one administrator in the MVP.
- Administration can be transferred to an active member.

### League configuration

- Configure visibility: private or searchable.
- Configure default selection mode.
- Configure default waitlist-promotion mode.
- Configure timezone, location, capacity, minimum threshold, deadlines, team count, positions, and rules.
- Configure roster visibility for members.
- Store versioned guidelines and acknowledgements.

### Match management

- Create, edit, publish, cancel, finalize, and complete a match.
- Create matches from reusable templates.
- Override league defaults per match.
- Maintain capacity and minimum-player state.
- Prevent unpublished drafts from appearing to players.

### Signup and roster

- Support immediate confirmation and administrator approval modes.
- Store exact response timestamps.
- Support optional priority-window flags without requiring every league to use them.
- Maintain one signup per player per match.
- Enforce capacity transactionally.
- Maintain an ordered waitlist.
- Allow administrator manual additions.
- Show members the full confirmed roster after publication.

### Team assignment

- Support two or more teams.
- Assign confirmed players only.
- Provide equal-size randomization.
- Save drafts without player visibility.
- Publish teams explicitly.
- Notify confirmed players when teams are published or changed.

### Notifications

- Store all notifications in an in-app inbox.
- Show unread count and read/unread state.
- Deep-link notifications to the relevant league, match, roster, team, or join request.
- Create notification events idempotently.
- Retain notification history for an administrator-defined period.

### Attendance

- Record attendance outcomes.
- Show league-specific participation and no-show history to the administrator.
- Do not expose disciplinary information to other players.
- Do not apply automatic suspensions in the MVP.

## 11. UX requirements

### Player home

The first screen should answer:

1. Which league am I viewing?
2. What is my next match?
3. What is my signup or roster status?
4. Is action required?
5. Are teams published?

### League switcher

- Visible when the user belongs to more than one league.
- Shows pending join requests separately from active memberships.
- Preserves the currently selected league between sessions.

### Match card

- League name
- Match title, date, and time
- Location
- Capacity and minimum threshold
- Current match state
- Player's status
- Deadline or late-cancellation warning
- Primary action

### Admin dashboard

- Pending join requests
- Upcoming matches
- Open spots and waitlist counts
- Matches below minimum threshold
- Draft or unpublished teams
- Unread administrative notifications
- Recent attendance requiring completion

## 12. Permissions and privacy

### Public/search result information

- League name
- General area
- Sport or format label
- Typical schedule, if configured
- Short description
- Request-to-join action

Do not expose member lists, rosters, player profile fields, attendance, or exact private locations publicly.

### Player access

- Their own global profile
- Leagues where they are active members
- Published matches for those leagues
- Their own signup, waitlist, attendance, and notification records
- Full confirmed rosters for member-visible matches
- Published team assignments for matches where they are confirmed

### Administrator access

- All data scoped to their league
- Join requests and memberships
- Match and roster management
- Optional player profile fields used for team assignment
- Attendance and no-show history
- Audit log

### Security requirements

- Every tenant-owned row includes or derives a league identifier.
- Server authorization and database Row Level Security both enforce tenancy.
- UI hiding is never treated as authorization.
- Administrator actions are audited.
- Invite tokens are revocable and unguessable.
- Public league search returns a deliberately limited projection.
- Gender and other profile fields are never shown publicly.

## 13. Success metrics

### Player clarity

- At least 90% of opened match pages result in a clear completed action or intentional decline.
- Fewer than 5% of active players ask the administrator whether they are confirmed.

### Administrator efficiency

- Publishing a recurring match takes under two minutes.
- Roster state can be understood without email or spreadsheets.
- Team assignment and publication can be completed in under five minutes for a 22-player match.

### Reliability

- No confirmed spot is duplicated under concurrent requests.
- Waitlist promotions are atomic.
- Every administrator mutation has an audit event.
- Cross-league access tests pass for all sensitive tables.

### Pilot adoption

- RMVFC uses the app as the source of truth for at least four matches.
- At least 80% of active pilot players sign up through the app.
- At least one cancellation, waitlist promotion, and team publication workflow is validated.

## 14. Risks and mitigations

### Risk: multi-league architecture increases MVP scope

**Mitigation:** implement tenancy and league switching from the beginning, but defer billing, advanced public discovery, and league analytics.

### Risk: in-app notifications are not noticed when the app is closed

**Mitigation:** decide whether Web Push is required before the notification phase. Keep notification events channel-independent so push or email can be added without changing domain logic.

### Risk: random teams are perceived as balanced

**Mitigation:** label the action `Randomize teams`, not `Balance teams`, and let the administrator adjust assignments.

### Risk: one administrator loses access

**Mitigation:** provide an ownership-transfer workflow and document a platform-support recovery process.

### Risk: leagues have subjective selection rules

**Mitigation:** support administrator approval and configurable context without building a universal ranking formula.

## 15. MVP release definition

The MVP is complete when:

- A user can create a league and become its administrator.
- A league can be private or searchable.
- A player can belong to multiple leagues and request to join a searchable league.
- The administrator can approve membership requests.
- The administrator can create and publish configurable matches.
- First-come and administrator-approved signup modes both work.
- Configurable automatic and administrator-controlled waitlists work safely.
- Members can see the full confirmed roster.
- Players can cancel and late cancellations are flagged.
- In-app notifications record important events.
- The administrator can create, randomize, edit, and publish multiple teams.
- Attendance and no-show warnings can be recorded without automatic suspension.
- Core flows pass automated tenancy, authorization, concurrency, and end-to-end tests.
- RMVFC completes a four-match pilot using the app as the source of truth.

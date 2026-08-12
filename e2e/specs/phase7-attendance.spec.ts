import type { Page } from '@playwright/test';
import { expect, expectNoServerError, expectRedirectedTo, test } from '../support/fixtures';
import type { TestDataFactory, TestLeague, TestMatch, TestUser } from '../support/factory';

/**
 * Phase 7 — attendance, completion, and the administrator's membership
 * decisions, through the browser.
 *
 * Parallel-safe: every test builds its own league, members and match.
 *
 * Matches are created in the future, seated, and then moved into the past with
 * `factory.endMatch()` — in that order, because signup closes hours before
 * kickoff and a match created in the past cannot be joined at all. Building it
 * the other way round would be fabricating a state the product cannot reach.
 *
 * Moving the clock is a fixture detail, not a bypass: `record_attendance()`
 * checks `now() >= end_at` itself, and the "not yet finished" case is asserted
 * separately below.
 */

async function seatPlayers(
  factory: TestDataFactory,
  league: TestLeague,
  match: TestMatch,
  count: number,
): Promise<TestUser[]> {
  const players: TestUser[] = [];
  for (let index = 0; index < count; index += 1) {
    const player = await factory.createMember(league);
    await factory.joinMatch(match, player);
    players.push(player);
  }
  return players;
}

/** The row carrying one player's outcome control. */
function attendanceRow(page: Page, player: TestUser) {
  return page
    .locator('li')
    .filter({ has: page.getByLabel(`Attendance for ${player.firstName} Tester`) })
    .first();
}

/**
 * The recorded-outcome summary for a row.
 *
 * Scoped to the `<p>` deliberately: every outcome label also appears as an
 * `<option>` inside the same row's select, so a plain text match is ambiguous
 * by construction rather than by accident.
 */
function recordedSummary(page: Page, player: TestUser) {
  return attendanceRow(page, player).locator('p');
}

/** Locates a member-management row by the membership it controls. */
function memberRow(page: Page, membershipId: string) {
  return page.locator('li').filter({ has: page.locator(`#status-${membershipId}`) }).first();
}

async function recordedOutcome(
  factory: TestDataFactory,
  matchId: string,
  player: TestUser,
): Promise<string | null> {
  const rows = await factory.query<{ outcome: string }>(
    `select outcome::text from public.attendance_records
      where match_id = $1 and membership_id = $2`,
    [matchId, player.membershipId],
  );
  return rows[0]?.outcome ?? null;
}

test.describe('recording attendance', () => {
  test('records an outcome for each player and completes the match', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    // Finished two hours ago: the ordinary case, an administrator filling in
    // the register on the way home.
    const match = await factory.createMatch(league, { capacity: 6 });
    const [alice, bob] = await seatPlayers(factory, league, match, 2);
    await factory.endMatch(match);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/${match.id}/attendance`);
    await expectNoServerError(admin);

    await expect(admin.getByRole('heading', { name: 'Attendance' })).toBeVisible();

    await attendanceRow(admin, alice!)
      .getByLabel(`Attendance for ${alice!.firstName} Tester`)
      .selectOption('attended');
    await attendanceRow(admin, alice!).getByRole('button', { name: 'Save' }).click();
    await expect(recordedSummary(admin, alice!).getByText(/^Attended ·/)).toBeVisible();

    await attendanceRow(admin, bob!)
      .getByLabel(`Attendance for ${bob!.firstName} Tester`)
      .selectOption('no_show');
    await attendanceRow(admin, bob!).getByRole('button', { name: 'Save' }).click();
    await expect(recordedSummary(admin, bob!).getByText(/^Did not attend ·/)).toBeVisible();

    expect(await recordedOutcome(factory, match.id, alice!)).toBe('attended');
    expect(await recordedOutcome(factory, match.id, bob!)).toBe('no_show');

    await admin.getByRole('button', { name: 'Complete match' }).click();
    await expect(admin.getByText(/This match is complete/i)).toBeVisible();

    const rows = await factory.query<{ status: string }>(
      'select status from public.matches where id = $1',
      [match.id],
    );
    expect(rows[0]?.status).toBe('completed');
  });

  test('refuses to complete a match while somebody has no outcome', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 6 });
    const [alice] = await seatPlayers(factory, league, match, 2);
    await factory.endMatch(match);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/${match.id}/attendance`);

    await attendanceRow(admin, alice!)
      .getByLabel(`Attendance for ${alice!.firstName} Tester`)
      .selectOption('attended');
    await attendanceRow(admin, alice!).getByRole('button', { name: 'Save' }).click();
    await expect(recordedSummary(admin, alice!).getByText(/^Attended ·/)).toBeVisible();

    await expect(admin.getByText('1 player still needs an outcome')).toBeVisible();
    await admin.getByRole('button', { name: 'Complete match' }).click();

    await expect(admin.getByText(/Record an outcome for everybody/i)).toBeVisible();
    const rows = await factory.query<{ status: string }>(
      'select status from public.matches where id = $1',
      [match.id],
    );
    expect(rows[0]?.status).toBe('open');
  });

  test('explains that a match which has not finished is not ready yet', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { kickoffInHours: 72 });
    await seatPlayers(factory, league, match, 1);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/${match.id}/attendance`);
    await expectNoServerError(admin);

    await expect(admin.getByText(/once the match has finished/i)).toBeVisible();
    await expect(admin.getByRole('button', { name: 'Complete match' })).toHaveCount(0);
  });

  test('corrects a record and tells the player again', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league);
    const [player] = await seatPlayers(factory, league, match, 1);
    await factory.endMatch(match);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/${match.id}/attendance`);

    const row = attendanceRow(admin, player!);
    await row.getByLabel(`Attendance for ${player!.firstName} Tester`).selectOption('no_show');
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(recordedSummary(admin, player!).getByText(/^Did not attend ·/)).toBeVisible();

    // They turned up after all, and the administrator puts it right.
    await row.getByLabel(`Attendance for ${player!.firstName} Tester`).selectOption('attended');
    await row.getByRole('button', { name: 'Update' }).click();
    await expect(recordedSummary(admin, player!).getByText(/^Attended ·/)).toBeVisible();
    await expect(recordedSummary(admin, player!).getByText(/corrected 1/)).toBeVisible();

    expect(await recordedOutcome(factory, match.id, player!)).toBe('attended');

    // One notification per recorded state, and the correction is its own.
    const notifications = await factory.query<{ count: string }>(
      `select count(*)::text as count from public.notifications
        where match_id = $1 and type = 'attendance_recorded' and recipient_user_id = $2`,
      [match.id, player!.id],
    );
    expect(Number(notifications[0]?.count ?? '0')).toBe(2);
  });

  test('offers a player who withdrew only the outcomes that fit', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league);
    const [player] = await seatPlayers(factory, league, match, 1);
    await factory.callAs(player!, 'select public.cancel_spot($1, $2)', [match.id, 'Injured']);
    await factory.endMatch(match);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/${match.id}/attendance`);

    const row = attendanceRow(admin, player!);
    // Still in the register — they were confirmed, so they need an outcome.
    await expect(row.getByText(/Withdrew/)).toBeVisible();

    const select = row.getByLabel(`Attendance for ${player!.firstName} Tester`);
    await expect(select.getByRole('option', { name: 'Cancelled on time' })).toHaveCount(1);
    // A player who told the league they were not coming is not a no-show.
    await expect(select.getByRole('option', { name: 'Did not attend' })).toHaveCount(0);
    await expect(select.getByRole('option', { name: 'Attended' })).toHaveCount(0);
  });

  test('leaves a waitlist-only withdrawal out of the register entirely', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 2 });
    const seated = await seatPlayers(factory, league, match, 2);
    const queued = await factory.createMember(league);
    await factory.joinMatch(match, queued); // waitlisted, never confirmed
    await factory.callAs(queued, 'select public.cancel_spot($1, $2)', [match.id, null]);
    await factory.endMatch(match);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/${match.id}/attendance`);

    // Their signup status is `canceled`, exactly like a confirmed player who
    // withdrew — which is why the register is defined by who was confirmed.
    await expect(admin.getByText(`${queued.firstName} Tester`, { exact: true })).toHaveCount(0);
    await expect(
      admin.getByText(`${seated[0]!.firstName} Tester`, { exact: true }),
    ).toBeVisible();
  });

  test('is refused to a player, who is redirected rather than shown an error', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league);
    const [player] = await seatPlayers(factory, league, match, 1);
    await factory.endMatch(match);

    const page = await asUser(player!.email);
    await expectRedirectedTo(
      page,
      `/leagues/${league.slug}/matches/${match.id}/attendance`,
      /\/dashboard/,
    );
    await expectNoServerError(page);
  });
});

test.describe('what a player sees about their own attendance', () => {
  test('shows their own outcome and nobody else’s', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league);
    const [alice, bob] = await seatPlayers(factory, league, match, 2);
    await factory.endMatch(match);

    await factory.callAs(
      league.admin,
      `select public.record_attendance($1, $2, 'no_show', $3)`,
      [match.id, alice!.membershipId, 'Said nothing, did not turn up'],
    );
    await factory.callAs(league.admin, `select public.record_attendance($1, $2, 'attended')`, [
      match.id,
      bob!.membershipId,
    ]);

    const page = await asUser(alice!.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expectNoServerError(page);

    const section = page.locator('section').filter({ hasText: 'Your attendance' }).first();
    await expect(section.getByText('Did not attend')).toBeVisible();

    // The administrator's note is not on the page in any form.
    await expect(page.getByText(/Said nothing/)).toHaveCount(0);
    // And neither is anybody else's outcome.
    await expect(section.getByText('Attended')).toHaveCount(0);
  });

  test('lists their own history on the league matches page', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league);
    const [player] = await seatPlayers(factory, league, match, 1);
    await factory.endMatch(match);

    await factory.callAs(league.admin, `select public.record_attendance($1, $2, 'attended')`, [
      match.id,
      player!.membershipId,
    ]);

    const page = await asUser(player!.email);
    await page.goto(`/leagues/${league.slug}/matches`);
    await expectNoServerError(page);

    const section = page.locator('section').filter({ hasText: 'Your attendance' }).first();
    await expect(section.getByRole('link', { name: match.title })).toBeVisible();
    await expect(section.getByText('Attended')).toBeVisible();
  });

  test('shows nothing at all before an administrator has recorded anything', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league);
    const [player] = await seatPlayers(factory, league, match, 1);
    await factory.endMatch(match);

    const page = await asUser(player!.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);

    await expect(page.getByText('Your attendance')).toHaveCount(0);
  });
});

test.describe('no-show context for the administrator', () => {
  test('shows the count beside a name and changes nothing about what they can do', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const past = await factory.createMatch(league);
    const player = await factory.createMember(league);
    await factory.joinMatch(past, player);
    await factory.endMatch(past);
    await factory.callAs(league.admin, `select public.record_attendance($1, $2, 'no_show')`, [
      past.id,
      player.membershipId,
    ]);

    // A new match, which they sign up for as normal.
    const upcoming = await factory.createMatch(league, { kickoffInHours: 72 });
    await factory.joinMatch(upcoming, player);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/${upcoming.id}/roster`);
    await expectNoServerError(admin);

    await expect(admin.getByText(/Did not attend 1 of 1 recorded match/)).toBeVisible();

    // The signup went through untouched: no automatic block, no demotion to the
    // waitlist, no reduced priority.
    const rows = await factory.query<{ status: string }>(
      'select status from public.match_signups where match_id = $1 and membership_id = $2',
      [upcoming.id, player.membershipId],
    );
    expect(rows[0]?.status).toBe('confirmed');
  });

  test('shows no attendance context for somebody with no record', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { kickoffInHours: 72 });
    await seatPlayers(factory, league, match, 1);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/${match.id}/roster`);

    // Not a zero. A fabricated statistic is worse than an absent one.
    await expect(admin.getByText(/recorded match/)).toHaveCount(0);
  });

  test('is never shown to a player', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const past = await factory.createMatch(league);
    const [alice, bob] = await seatPlayers(factory, league, past, 2);
    await factory.endMatch(past);
    await factory.callAs(league.admin, `select public.record_attendance($1, $2, 'no_show')`, [
      past.id,
      alice!.membershipId,
    ]);

    const page = await asUser(bob!.email);
    await page.goto(`/leagues/${league.slug}/matches/${past.id}`);
    await expectNoServerError(page);

    await expect(page.getByText(/recorded match/)).toHaveCount(0);
    await expect(page.getByText('Did not attend')).toHaveCount(0);
  });
});

test.describe('suspending and removing a member', () => {
  test('releases the spots they held and promotes a replacement', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { kickoffInHours: 72, capacity: 2 });
    const seated = await seatPlayers(factory, league, match, 2);
    const queued = await factory.createMember(league);
    await factory.joinMatch(match, queued); // waitlisted behind them

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/members`);
    await expectNoServerError(admin);

    const row = memberRow(admin, seated[0]!.membershipId);
    await row.getByLabel('Membership status').selectOption('suspended');
    await row.getByLabel('Reason for the change').fill('Repeated abuse in the group chat');
    await row.getByRole('button', { name: 'Update' }).click();

    await expect(row.getByText(/Repeated abuse/)).toBeVisible();

    const signups = await factory.query<{ membership_id: string; status: string }>(
      'select membership_id, status from public.match_signups where match_id = $1',
      [match.id],
    );
    const byId = new Map(signups.map((r) => [r.membership_id, r.status]));

    // Not `canceled`: an administrator decided, and recording it as a player
    // withdrawal would put words in their mouth.
    expect(byId.get(seated[0]!.membershipId)).toBe('not_selected');
    // The waitlisted player takes the freed place.
    expect(byId.get(queued.membershipId)).toBe('confirmed');
  });

  test('sends the suspended player no cancellation receipt', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { kickoffInHours: 72 });
    const [player] = await seatPlayers(factory, league, match, 1);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/members`);

    const row = memberRow(admin, player!.membershipId);
    await row.getByLabel('Membership status').selectOption('removed');
    await row.getByLabel('Reason for the change').fill('Left the club');
    await row.getByRole('button', { name: 'Update' }).click();

    // A removed member drops off the list entirely — Phase 2 keeps them on
    // record and hides them, and their profile stops being readable to the
    // administrator at all. Waiting for the row to go is what makes the
    // assertions below run after the action rather than during it.
    await expect(admin.locator(`#status-${player!.membershipId}`)).toHaveCount(0);
    await expect(admin.getByText(/removed member .* kept on record/)).toBeVisible();

    const receipts = await factory.query<{ count: string }>(
      `select count(*)::text as count from public.notifications
        where recipient_user_id = $1 and type = 'cancellation_receipt'`,
      [player!.id],
    );
    expect(receipts[0]?.count).toBe('0');
  });

  test('refuses without a reason', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/members`);

    const row = memberRow(admin, player.membershipId);
    await row.getByLabel('Membership status').selectOption('suspended');
    await row.getByRole('button', { name: 'Update' }).click();

    await expect(row.getByText(/Give a reason/i)).toBeVisible();

    const rows = await factory.query<{ status: string }>(
      'select status from public.league_memberships where id = $1',
      [player.membershipId],
    );
    expect(rows[0]?.status).toBe('active');
  });

  test('never shows the reason to the member it is about', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    await factory.callAs(
      league.admin,
      `select public.set_membership_status($1, 'suspended', $2)`,
      [player.membershipId, 'Threatened another player'],
    );

    const page = await asUser(player.email);
    await page.goto('/dashboard');
    await expectNoServerError(page);
    await expect(page.getByText(/Threatened/)).toHaveCount(0);

    await page.goto('/notifications');
    await expect(page.getByText(/Threatened/)).toHaveCount(0);
  });

  test('offers no control that could leave the league without an administrator', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    await factory.createMember(league);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/members`);

    const own = admin
      .locator('li')
      .filter({ hasText: `${league.admin.firstName} Tester (you)` })
      .first();
    await expect(own).toBeVisible();
    await expect(own.getByLabel('Membership status')).toHaveCount(0);
    await expect(own.getByRole('button', { name: 'Update' })).toHaveCount(0);
  });
});

test.describe('a no-show disciplines nobody', () => {
  test('leaves a member with five no-shows fully able to play', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    for (let index = 0; index < 5; index += 1) {
      const past = await factory.createMatch(league);
      await factory.joinMatch(past, player);
      await factory.endMatch(past, 2 + index);
      await factory.callAs(league.admin, `select public.record_attendance($1, $2, 'no_show')`, [
        past.id,
        player.membershipId,
      ]);
    }

    const membership = await factory.query<{ status: string; suspended_until: string | null }>(
      'select status, suspended_until::text from public.league_memberships where id = $1',
      [player.membershipId],
    );
    expect(membership[0]?.status).toBe('active');
    expect(membership[0]?.suspended_until).toBeNull();

    // And they sign up for the next match through the ordinary UI, confirmed.
    const upcoming = await factory.createMatch(league, { kickoffInHours: 72, capacity: 6 });
    const page = await asUser(player.email);
    await page.goto(`/leagues/${league.slug}/matches/${upcoming.id}`);
    await expect(page.getByRole('button', { name: 'Join match' })).toBeVisible();
    await page.getByRole('button', { name: 'Join match' }).click();

    // Waiting for the control that only exists once they hold a spot.
    //
    // Not `/Confirmed/`, which matches the "Confirmed roster" heading already
    // on the page, and not the absence of "Join match", which becomes true the
    // instant the button relabels itself "Working…" — both pass before the
    // action has committed, and the database read below then finds nothing.
    await expect(page.getByRole('button', { name: 'Cancel my spot' })).toBeVisible();

    const rows = await factory.query<{ status: string }>(
      'select status from public.match_signups where match_id = $1 and membership_id = $2',
      [upcoming.id, player.membershipId],
    );
    expect(rows[0]?.status).toBe('confirmed');
  });
});

/**
 * Regression — a published roster used to take away the cancel button.
 *
 * `SignupControls` returned early on any eligibility code other than
 * `ELIGIBLE`, and both `finalize_roster()` and a closed signup window produce
 * one. So the moment an administrator published the roster, a confirmed player
 * had no way to say they could not make it — in exactly the hours when the
 * administrator most needs to know, and while `cancel_spot()` was perfectly
 * willing to accept it.
 */
test.describe('leaving a match after signup has closed', () => {
  test('a confirmed player can still withdraw once the roster is published', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 6 });
    const players = [];
    for (let index = 0; index < 3; index += 1) {
      const player = await factory.createMember(league);
      await factory.joinMatch(match, player);
      players.push(player);
    }
    await factory.callAs(league.admin, 'select public.finalize_roster($1)', [match.id]);

    const page = await asUser(players[0]!.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expectNoServerError(page);

    // Both truths on screen at once: no new signups, and you may still leave.
    await expect(page.getByText(/nobody new can join/i)).toBeVisible();
    await expect(page.getByText(/You still have your spot/i)).toBeVisible();
    await page.getByRole('button', { name: 'Cancel my spot' }).click();
    await page.getByRole('button', { name: 'Yes, cancel my spot' }).click();

    // Waiting for the state that only exists once the withdrawal has committed:
    // holding no place, the closed-match message is all that is left. Watching
    // for the button to vanish would pass the instant the confirmation form
    // replaced it, before the action had run.
    await expect(page.getByText('This match is not accepting responses.')).toBeVisible();

    const rows = await factory.query<{ status: string }>(
      'select status from public.match_signups where match_id = $1 and membership_id = $2',
      [match.id, players[0]!.membershipId],
    );
    expect(rows[0]?.status).toBe('canceled');
  });

  test('a waitlisted player can still leave the queue after signup closes', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 2 });
    const players = [];
    for (let index = 0; index < 3; index += 1) {
      const player = await factory.createMember(league);
      await factory.joinMatch(match, player);
      players.push(player);
    }
    await factory.closeSignup(match);

    const page = await asUser(players[2]!.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);

    await page.getByRole('button', { name: 'Leave the waitlist' }).click();
    await page.getByRole('button', { name: 'Yes, leave the waitlist' }).click();

    await expect(page.getByText('Signup for this match has closed.')).toBeVisible();

    const rows = await factory.query<{ status: string }>(
      'select status from public.match_signups where match_id = $1 and membership_id = $2',
      [match.id, players[2]!.membershipId],
    );
    expect(rows[0]?.status).toBe('canceled');
  });

  test('somebody with no place is still simply told the match is closed', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 6 });
    const onlooker = await factory.createMember(league);
    await factory.closeSignup(match);

    const page = await asUser(onlooker.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);

    await expect(page.getByText(/closed/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Cancel my spot|Leave the waitlist/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Join match' })).toHaveCount(0);
  });
});

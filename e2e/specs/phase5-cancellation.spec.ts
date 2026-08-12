import { expect, expectNoServerError, test } from '../support/fixtures';
import type { TestDataFactory } from '../support/factory';

/**
 * Phase 5 — cancellation, waitlist promotion, the notification centre and
 * reminders.
 *
 * Parallel-safe: every test builds its own league, members and matches.
 */

async function statusOf(
  factory: TestDataFactory,
  matchId: string,
  membershipId: string,
): Promise<string | undefined> {
  const rows = await factory.query<{ status: string }>(
    'select status::text from public.match_signups where match_id = $1 and membership_id = $2',
    [matchId, membershipId],
  );
  return rows[0]?.status;
}

async function waitlistOrder(factory: TestDataFactory, matchId: string): Promise<string[]> {
  const rows = await factory.query<{ membership_id: string }>(
    `select membership_id from public.match_signups
      where match_id = $1 and status = 'waitlisted' order by waitlist_position`,
    [matchId],
  );
  return rows.map((row) => row.membership_id);
}

async function notificationCount(
  factory: TestDataFactory,
  matchId: string,
  type: string,
): Promise<number> {
  const rows = await factory.query<{ count: string }>(
    `select count(*)::text as count from public.notifications
      where match_id = $1 and type = $2::public.notification_type`,
    [matchId, type],
  );
  return Number(rows[0]?.count ?? '0');
}

test.describe('on-time cancellation', () => {
  test('warns it is on time, needs confirming, and releases the spot', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 4 });
    const member = await factory.createMember(league);
    await factory.joinMatch(match, member);

    const page = await asUser(member.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(page.getByText('You are playing')).toBeVisible();

    // The cutoff is shown before anything is pressed.
    await expect(page.getByText(/Cancellation cutoff:/)).toBeVisible();

    await page.getByRole('button', { name: 'Cancel my spot' }).click();

    // A second, explicit step — and it says the consequence first.
    await expect(page.getByText(/Cancelling now is/)).toBeVisible();
    await expect(page.getByText(/on time/)).toBeVisible();

    await page.getByRole('button', { name: 'Yes, cancel my spot' }).click();

    await expect.poll(() => statusOf(factory, match.id, member.membershipId)).toBe('canceled');

    await page.reload();
    await expect(page.getByText('You cancelled and are no longer on the roster.')).toBeVisible();
    // The spot is back.
    await expect(page.getByText('0 of 4 confirmed')).toBeVisible();
  });

  test('the canceller gets a receipt', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 4 });
    const member = await factory.createMember(league);
    await factory.joinMatch(match, member);

    const page = await asUser(member.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await page.getByRole('button', { name: 'Cancel my spot' }).click();
    await page.getByRole('button', { name: 'Yes, cancel my spot' }).click();
    await expect.poll(() => statusOf(factory, match.id, member.membershipId)).toBe('canceled');

    await page.goto('/notifications');
    await expect(page.getByText(/Cancelled: /)).toBeVisible();
  });

  test('the reason is never shown to anybody else', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 4 });
    const leaver = await factory.createMember(league);
    const other = await factory.createMember(league);
    await factory.joinMatch(match, leaver);
    await factory.joinMatch(match, other);

    const page = await asUser(leaver.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await page.getByRole('button', { name: 'Cancel my spot' }).click();
    await page.getByLabel('Reason').fill('CONFIDENTIAL-E2E-REASON');
    await page.getByRole('button', { name: 'Yes, cancel my spot' }).click();
    await expect.poll(() => statusOf(factory, match.id, leaver.membershipId)).toBe('canceled');

    // Not on another member's view of the match, nor in their inbox.
    const otherPage = await asUser(other.email);
    await otherPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(otherPage.locator('body')).not.toContainText('CONFIDENTIAL-E2E-REASON');
    await otherPage.goto('/notifications');
    await expect(otherPage.locator('body')).not.toContainText('CONFIDENTIAL-E2E-REASON');

    // Nor in the administrator's roster workspace notifications.
    const adminPage = await asUser(league.admin.email);
    await adminPage.goto('/notifications');
    await expect(adminPage.locator('body')).not.toContainText('CONFIDENTIAL-E2E-REASON');
  });

  test('cancelling twice does not duplicate anything', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 2 });
    const leaver = await factory.createMember(league);
    const seated = await factory.createMember(league);
    const queued = await factory.createMember(league);
    for (const member of [leaver, seated, queued]) {
      await factory.joinMatch(match, member);
    }

    const page = await asUser(leaver.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await page.getByRole('button', { name: 'Cancel my spot' }).click();
    await page.getByRole('button', { name: 'Yes, cancel my spot' }).click();
    await expect.poll(() => statusOf(factory, match.id, leaver.membershipId)).toBe('canceled');

    // Reload and confirm the control is gone; the operation is idempotent
    // server-side either way.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Cancel my spot' })).toHaveCount(0);

    expect(await notificationCount(factory, match.id, 'cancellation_receipt')).toBe(1);
    expect(await notificationCount(factory, match.id, 'waitlist_promotion')).toBe(1);
  });
});

test('a late cancellation warns first, records a late withdrawal and alerts the administrator', async ({
  factory,
  asUser,
}) => {
  const league = await factory.createLeague();
  const match = await factory.createMatch(league, { capacity: 4 });
  const member = await factory.createMember(league);
  await factory.joinMatch(match, member);
  await factory.expireCancellationCutoff(match);

  const page = await asUser(member.email);
  await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
  await page.getByRole('button', { name: 'Cancel my spot' }).click();

  await expect(page.getByText('This is a late cancellation.')).toBeVisible();
  // The player is never *called* a no-show. The only mention is the explicit
  // reassurance that this is not one — an attendance judgement nobody has made,
  // and one Phase 7 owns.
  await expect(page.getByText('This is not recorded as a no-show.')).toBeVisible();

  await page.getByRole('button', { name: 'Yes, cancel my spot' }).click();
  await expect.poll(() => statusOf(factory, match.id, member.membershipId)).toBe('withdrawn_late');

  await page.reload();
  await expect(page.getByText('Withdrew late')).toBeVisible();

  const adminPage = await asUser(league.admin.email);
  await adminPage.goto('/notifications');
  await expect(adminPage.getByText(/Late withdrawal:/)).toBeVisible();
  // The administrator is told somebody withdrew late, never that they failed
  // to turn up.
  await expect(adminPage.locator('body')).not.toContainText(/no.?show/i);
});

test.describe('waitlist withdrawal', () => {
  test('frees no capacity, promotes nobody, and compacts the queue', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 2 });
    const seatedA = await factory.createMember(league);
    const seatedB = await factory.createMember(league);
    const first = await factory.createMember(league);
    const second = await factory.createMember(league);
    const third = await factory.createMember(league);
    for (const member of [seatedA, seatedB, first, second, third]) {
      await factory.joinMatch(match, member);
    }

    const page = await asUser(second.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(page.getByText('Waitlisted — position 2')).toBeVisible();

    await page.getByRole('button', { name: 'Leave the waitlist' }).click();
    // Their own position is shown before the irreversible press.
    await expect(page.getByText(/You are number 2 on the waitlist/)).toBeVisible();
    await page.getByRole('button', { name: 'Yes, leave the waitlist' }).click();

    await expect.poll(() => statusOf(factory, match.id, second.membershipId)).toBe('canceled');

    // No capacity moved, nobody promoted, and the queue closed up.
    const confirmed = await factory.query<{ count: string }>(
      `select count(*)::text as count from public.match_signups
        where match_id = $1 and status = 'confirmed'`,
      [match.id],
    );
    expect(confirmed[0]?.count).toBe('2');
    expect(await notificationCount(factory, match.id, 'waitlist_promotion')).toBe(0);
    expect(await waitlistOrder(factory, match.id)).toEqual([
      first.membershipId,
      third.membershipId,
    ]);
  });
});

test.describe('automatic promotion', () => {
  test('promotes exactly one player and moves the rest up', async ({ factory, asUser }) => {
    const league = await factory.createLeague({ waitlistMode: 'automatic' });
    const match = await factory.createMatch(league, {
      capacity: 2,
      waitlistMode: 'automatic',
    });
    const leaving = await factory.createMember(league);
    const staying = await factory.createMember(league);
    const firstInQueue = await factory.createMember(league);
    const secondInQueue = await factory.createMember(league);
    for (const member of [leaving, staying, firstInQueue, secondInQueue]) {
      await factory.joinMatch(match, member);
    }

    const page = await asUser(leaving.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await page.getByRole('button', { name: 'Cancel my spot' }).click();
    await page.getByRole('button', { name: 'Yes, cancel my spot' }).click();

    await expect
      .poll(() => statusOf(factory, match.id, firstInQueue.membershipId))
      .toBe('confirmed');

    // Exactly one promotion, the queue compacted, capacity respected.
    expect(await notificationCount(factory, match.id, 'waitlist_promotion')).toBe(1);
    expect(await waitlistOrder(factory, match.id)).toEqual([secondInQueue.membershipId]);

    const promotedPage = await asUser(firstInQueue.email);
    await promotedPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(promotedPage.getByText('You are playing')).toBeVisible();
    await promotedPage.goto('/notifications');
    await expect(promotedPage.getByText(/You are in:/)).toBeVisible();

    // The player behind them moved up by one.
    const movedPage = await asUser(secondInQueue.email);
    await movedPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(movedPage.getByText('Waitlisted — position 1')).toBeVisible();
  });

  test('skips a candidate who is no longer eligible', async ({ factory, asUser }) => {
    const league = await factory.createLeague({ waitlistMode: 'automatic' });
    const match = await factory.createMatch(league, { capacity: 2, waitlistMode: 'automatic' });
    const leaving = await factory.createMember(league);
    const staying = await factory.createMember(league);
    const suspendedLater = await factory.createMember(league);
    const nextEligible = await factory.createMember(league);
    for (const member of [leaving, staying, suspendedLater, nextEligible]) {
      await factory.joinMatch(match, member);
    }

    // First in the queue loses their membership standing after joining.
    await factory.query(
      `update public.league_memberships set status = 'suspended' where id = $1`,
      [suspendedLater.membershipId],
    );

    const page = await asUser(leaving.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await page.getByRole('button', { name: 'Cancel my spot' }).click();
    await page.getByRole('button', { name: 'Yes, cancel my spot' }).click();

    await expect
      .poll(() => statusOf(factory, match.id, nextEligible.membershipId))
      .toBe('confirmed');
    // Skipped, not dropped: they keep their place should they be reinstated.
    expect(await statusOf(factory, match.id, suspendedLater.membershipId)).toBe('waitlisted');
  });
});

test.describe('administrator-controlled replacement', () => {
  test('promotes nobody automatically, alerts the administrator, and promotes on request', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague({ waitlistMode: 'admin_controlled' });
    const match = await factory.createMatch(league, {
      capacity: 2,
      waitlistMode: 'admin_controlled',
    });
    const leaving = await factory.createMember(league);
    const staying = await factory.createMember(league);
    const recommended = await factory.createMember(league);
    const alternate = await factory.createMember(league);
    for (const member of [leaving, staying, recommended, alternate]) {
      await factory.joinMatch(match, member);
    }

    const leaverPage = await asUser(leaving.email);
    await leaverPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await leaverPage.getByRole('button', { name: 'Cancel my spot' }).click();
    await leaverPage.getByRole('button', { name: 'Yes, cancel my spot' }).click();
    await expect.poll(() => statusOf(factory, match.id, leaving.membershipId)).toBe('canceled');

    // Nobody was moved: that is the entire point of this mode.
    expect(await statusOf(factory, match.id, recommended.membershipId)).toBe('waitlisted');
    expect(await notificationCount(factory, match.id, 'waitlist_promotion')).toBe(0);

    const adminPage = await asUser(league.admin.email);
    await adminPage.goto('/notifications');
    await expect(adminPage.getByText(/A spot opened:/)).toBeVisible();

    await adminPage.goto(`/leagues/${league.slug}/matches/${match.id}/roster`);
    await expect(adminPage.getByRole('heading', { name: 'Open spots (1)' })).toBeVisible();
    await expect(adminPage.getByText(/Recommended: /)).toBeVisible();

    await adminPage.getByRole('button', { name: 'Promote to the roster' }).click();

    await expect
      .poll(() => statusOf(factory, match.id, recommended.membershipId))
      .toBe('confirmed');
    expect(await waitlistOrder(factory, match.id)).toEqual([alternate.membershipId]);

    const promotedPage = await asUser(recommended.email);
    await promotedPage.goto('/notifications');
    await expect(promotedPage.getByText(/You are in:/)).toBeVisible();
  });

  test('promoting out of order requires a reason, which stays administrator-only', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague({ waitlistMode: 'admin_controlled' });
    const match = await factory.createMatch(league, {
      capacity: 2,
      waitlistMode: 'admin_controlled',
    });
    const leaving = await factory.createMember(league);
    const staying = await factory.createMember(league);
    const recommended = await factory.createMember(league);
    const alternate = await factory.createMember(league);
    for (const member of [leaving, staying, recommended, alternate]) {
      await factory.joinMatch(match, member);
    }
    await factory.callAs(leaving, 'select public.cancel_spot($1)', [match.id]);

    const page = await asUser(league.admin.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}/roster`);

    // Choosing somebody other than the recommendation reveals a required field.
    // Scoped to the open-spots panel: the manual-add form also has an override
    // reason field, and an unscoped label matches both.
    const panel = page.locator('section', { hasText: 'Open spots' }).first();

    // Selected by value: the visible label carries the waitlist position, which
    // compaction may have changed.
    await panel.getByLabel('Player to promote').selectOption(alternate.membershipId);
    const reason = panel.getByLabel('Override reason');
    await expect(reason).toBeVisible();

    await reason.fill('SECRET-OVERRIDE-NOTE');
    await panel.getByRole('button', { name: 'Promote to the roster' }).click();

    await expect.poll(() => statusOf(factory, match.id, alternate.membershipId)).toBe('confirmed');

    // The note is administrator-only: it never reaches the promoted player.
    const promotedPage = await asUser(alternate.email);
    await promotedPage.goto('/notifications');
    await expect(promotedPage.locator('body')).not.toContainText('SECRET-OVERRIDE-NOTE');
    await promotedPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(promotedPage.locator('body')).not.toContainText('SECRET-OVERRIDE-NOTE');
  });

  test('a player cannot promote anybody', async ({ factory, asUser }) => {
    const league = await factory.createLeague({ waitlistMode: 'admin_controlled' });
    const match = await factory.createMatch(league, {
      capacity: 2,
      waitlistMode: 'admin_controlled',
    });
    const member = await factory.createMember(league);
    await factory.joinMatch(match, member);

    const page = await asUser(member.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(page.getByRole('button', { name: 'Promote to the roster' })).toHaveCount(0);
  });
});

test('a confirmed player is not offered a fake cancellation control before Phase 5 semantics apply', async ({
  factory,
  asUser,
}) => {
  // The pre-confirmation response stays available to somebody with no place.
  const league = await factory.createLeague();
  const match = await factory.createMatch(league, { capacity: 4 });
  const member = await factory.createMember(league);

  const page = await asUser(member.email);
  await page.goto(`/leagues/${league.slug}/matches/${match.id}`);

  await expect(page.getByRole('button', { name: 'Can’t play' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel my spot' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Can’t play' }).click();
  await expect.poll(() => statusOf(factory, match.id, member.membershipId)).toBe('not_available');
  await expectNoServerError(page);
});

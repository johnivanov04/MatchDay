import { expect, expectNoServerError, expectRedirectedTo, test } from '../support/fixtures';

/**
 * Phase 4 — first-come signup, administrator-approved selection and the roster
 * workspace.
 *
 * Parallel-safe: every test builds its own league, members and matches.
 */

test.describe('first-come signup', () => {
  test('confirms while spots remain, then waitlists with a position', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague({ selectionMode: 'first_come' });
    const match = await factory.createMatch(league, { capacity: 2, selectionMode: 'first_come' });

    const first = await factory.createMember(league);
    const second = await factory.createMember(league);
    const third = await factory.createMember(league);
    const fourth = await factory.createMember(league);

    const firstPage = await asUser(first.email);
    await firstPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await firstPage.getByRole('button', { name: 'Join match' }).click();
    await expect(firstPage.getByText('You are playing')).toBeVisible();

    // Filling the final slot.
    await factory.joinMatch(match, second);

    // The next arrival queues, and is told their own position.
    const thirdPage = await asUser(third.email);
    await thirdPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await thirdPage.getByRole('button', { name: 'Join match' }).click();
    await expect(thirdPage.getByText('Waitlisted — position 1')).toBeVisible();

    const fourthPage = await asUser(fourth.email);
    await fourthPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await fourthPage.getByRole('button', { name: 'Join match' }).click();
    await expect(fourthPage.getByText('Waitlisted — position 2')).toBeVisible();

    // Each sees only their own place, never the queue.
    await expect(thirdPage.locator('body')).not.toContainText(fourth.firstName);
    await expect(fourthPage.locator('body')).not.toContainText('position 1');
  });

  test('a repeated join is idempotent', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 4 });
    const member = await factory.createMember(league);

    const page = await asUser(member.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await page.getByRole('button', { name: 'Join match' }).click();
    await expect(page.getByText('You are playing')).toBeVisible();

    // The control is gone once they hold a spot, so a second tap is a reload.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Join match' })).toHaveCount(0);

    const rows = await factory.query<{ count: string }>(
      'select count(*)::text as count from public.match_signups where match_id = $1',
      [match.id],
    );
    expect(rows[0]?.count).toBe('1');
  });

  test('members see the confirmed roster', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 4 });
    const playing = await factory.createMember(league);
    const watching = await factory.createMember(league);
    await factory.joinMatch(match, playing);

    const page = await asUser(watching.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);

    // 02 §12: the full confirmed roster is member-visible.
    await expect(page.getByText(playing.firstName).first()).toBeVisible();
    await expect(page.getByText('1 of 4 confirmed')).toBeVisible();
  });

  test('an outstanding required guideline blocks signup until it is accepted', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    await factory.publishRequiredGuideline(league);
    const match = await factory.createMatch(league, { capacity: 4 });
    const member = await factory.createMember(league, { acceptsGuidelines: false });

    const page = await asUser(member.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);

    await expect(page.getByRole('button', { name: 'Join match' })).toHaveCount(0);
    await expect(page.getByText(/Accept the league guidelines/)).toBeVisible();

    // Accepting unblocks it.
    await page.goto(`/leagues/${league.slug}/guidelines`);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Accept guidelines' }).click();
    await expect
      .poll(async () => {
        const rows = await factory.query<{ count: string }>(
          'select count(*)::text as count from public.guideline_acceptances where membership_id = $1',
          [member.membershipId],
        );
        return rows[0]?.count;
      })
      .toBe('1');

    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(page.getByRole('button', { name: 'Join match' })).toBeVisible();
  });

  test('signup after the deadline is refused', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 4 });
    const member = await factory.createMember(league);
    await factory.closeSignup(match);

    const page = await asUser(member.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);

    await expect(page.getByText('Signup for this match has closed.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Join match' })).toHaveCount(0);
  });

  test('a canceled match takes no signups', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 4 });
    const member = await factory.createMember(league);

    await factory.query(
      `update public.matches set status = 'canceled', canceled_at = now() where id = $1`,
      [match.id],
    );

    const page = await asUser(member.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(page.getByText(/This match was canceled/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Join match' })).toHaveCount(0);
  });

  test('a suspended member cannot sign up', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 4 });
    const suspended = await factory.createMember(league, { status: 'suspended' });

    const page = await asUser(suspended.email);
    await expectRedirectedTo(
      page,
      `/leagues/${league.slug}/matches/${match.id}`,
      '/dashboard',
    );
  });
});

test.describe('administrator-approved signup', () => {
  test('a request is pending, and says so in as many words', async ({ factory, asUser }) => {
    const league = await factory.createLeague({ selectionMode: 'admin_approval' });
    const match = await factory.createMatch(league, {
      selectionMode: 'admin_approval',
      capacity: 4,
    });
    const member = await factory.createMember(league);

    const page = await asUser(member.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);

    await expect(page.getByRole('button', { name: 'Join match' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Request a spot' }).click();

    await expect(page.getByText('Selection pending')).toBeVisible();
    // 02 §11 requires the interface to say plainly that this is not a spot.
    await expect(page.getByText(/not a confirmed spot/)).toBeVisible();

    // A request consumes no capacity.
    await expect(page.getByText('0 of 4 confirmed')).toBeVisible();
  });

  test('the workspace confirms, waitlists, passes over and reorders', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague({ selectionMode: 'admin_approval' });
    const match = await factory.createMatch(league, {
      selectionMode: 'admin_approval',
      capacity: 2,
    });

    const alice = await factory.createMember(league);
    const bob = await factory.createMember(league);
    const carol = await factory.createMember(league);
    for (const member of [alice, bob, carol]) {
      await factory.requestSpot(match, member);
    }

    const page = await asUser(league.admin.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}/roster`);

    // Scoped to the list: the same name also appears as an <option> in the
    // manual-add picker, and an unscoped match is ambiguous.
    await expect(page.getByRole('heading', { name: 'Requested a spot (3)' })).toBeVisible();
    await expect(page.getByRole('list').getByText(alice.firstName)).toBeVisible();

    // Confirm the first.
    await page
      .locator('li', { hasText: alice.firstName })
      .getByRole('button', { name: 'Confirm' })
      .click();
    await expect.poll(() => statusOf(factory, match.id, alice.membershipId)).toBe('confirmed');

    // Waitlist the other two, then reorder them.
    for (const member of [bob, carol]) {
      await page.reload();
      await page
        .locator('li', { hasText: member.firstName })
        .getByRole('button', { name: 'Waitlist' })
        .click();
      await expect.poll(() => statusOf(factory, match.id, member.membershipId)).toBe('waitlisted');
    }

    await page.reload();
    await expect(page.getByRole('heading', { name: /Waitlist order/ })).toBeVisible();
    await page.getByRole('button', { name: `Move ${carol.firstName} Tester up` }).click();
    await page.getByRole('button', { name: 'Save this order' }).click();

    await expect
      .poll(async () => {
        const rows = await factory.query<{ membership_id: string }>(
          `select membership_id from public.match_signups
            where match_id = $1 and status = 'waitlisted' order by waitlist_position`,
          [match.id],
        );
        return rows[0]?.membership_id;
      })
      .toBe(carol.membershipId);

    // Pass somebody over.
    await page.reload();
    await page
      .locator('li', { hasText: bob.firstName })
      .getByRole('button', { name: 'Not selected' })
      .click();
    await expect.poll(() => statusOf(factory, match.id, bob.membershipId)).toBe('not_selected');
  });

  test('a manual addition is capped by capacity', async ({ factory, asUser }) => {
    const league = await factory.createLeague({ selectionMode: 'admin_approval' });
    const match = await factory.createMatch(league, {
      selectionMode: 'admin_approval',
      capacity: 2,
    });
    const seated = await factory.createMember(league);
    const alsoSeated = await factory.createMember(league);
    const spare = await factory.createMember(league);

    const page = await asUser(league.admin.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}/roster`);

    // Add two through the interface; the second fills the match.
    for (const member of [seated, alsoSeated]) {
      await page.reload();
      const picker = page.getByLabel('Member');
      if ((await picker.locator(`option:has-text("${member.firstName}")`).count()) === 0) continue;
      await picker.selectOption({ label: `${member.firstName} Tester` });
      await page.getByLabel('Add as').selectOption('confirmed');
      await page.getByRole('button', { name: 'Add to this match' }).click();
      await page.waitForTimeout(300);
    }

    await expect.poll(() => confirmedCount(factory, match.id)).toBe(2);

    // A third confirmed addition must be refused, in the form.
    await page.reload();
    const picker = page.getByLabel('Member');
    await picker.selectOption({ label: `${spare.firstName} Tester` });
    await page.getByLabel('Add as').selectOption('confirmed');
    await page.getByRole('button', { name: 'Add to this match' }).click();

    await expect(page.getByRole('alert').first()).toBeVisible();
    await expectNoServerError(page);
    expect(await confirmedCount(factory, match.id)).toBe(2);
  });

  test('publishing the roster tells each affected player their own outcome', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague({ selectionMode: 'admin_approval' });
    const match = await factory.createMatch(league, {
      selectionMode: 'admin_approval',
      capacity: 2,
    });
    const chosen = await factory.createMember(league);
    const queued = await factory.createMember(league);

    await factory.requestSpot(match, chosen);
    await factory.requestSpot(match, queued);
    // As the administrator: these functions derive their actor from auth.uid().
    await factory.callAs(league.admin, `select public.set_signup_decision($1, $2, 'confirmed')`, [
      match.id,
      chosen.membershipId,
    ]);
    await factory.callAs(league.admin, `select public.set_signup_decision($1, $2, 'waitlisted')`, [
      match.id,
      queued.membershipId,
    ]);

    const page = await asUser(league.admin.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}/roster`);
    await page.getByRole('button', { name: 'Publish roster' }).click();

    await expect
      .poll(async () => {
        const rows = await factory.query<{ revision: number }>(
          'select roster_revision as revision from public.matches where id = $1',
          [match.id],
        );
        return rows[0]?.revision;
      })
      .toBe(1);

    // One outcome notification each, and the right one.
    const chosenPage = await asUser(chosen.email);
    await chosenPage.goto('/notifications');
    await expect(chosenPage.getByText(/You are playing:/)).toBeVisible();

    const queuedPage = await asUser(queued.email);
    await queuedPage.goto('/notifications');
    await expect(queuedPage.getByText(/Waitlisted:/)).toBeVisible();

    // Publishing again announces nothing new.
    await page.reload();
    await page.getByRole('button', { name: 'Publish changes' }).click();
    await page.waitForTimeout(700);

    const rows = await factory.query<{ revision: number }>(
      'select roster_revision as revision from public.matches where id = $1',
      [match.id],
    );
    // Republishing with nothing changed advances nothing and announces nothing.
    expect(rows[0]?.revision).toBe(1);
  });
});

test.describe('roster privacy', () => {
  test('a player cannot open the roster workspace', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league);
    const member = await factory.createMember(league);

    const page = await asUser(member.email);
    await expectRedirectedTo(
      page,
      `/leagues/${league.slug}/matches/${match.id}/roster`,
      '/dashboard',
    );
  });

  test('a cross-league administrator cannot open it either', async ({ factory, asUser }) => {
    const mine = await factory.createLeague();
    const theirs = await factory.createLeague();
    const match = await factory.createMatch(theirs);

    const page = await asUser(mine.admin.email);
    await expectRedirectedTo(
      page,
      `/leagues/${theirs.slug}/matches/${match.id}/roster`,
      '/dashboard',
    );
  });

  test('a waitlisted player sees the roster but never the queue', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 1 + 1 });
    const seatedA = await factory.createMember(league);
    const seatedB = await factory.createMember(league);
    const queuedFirst = await factory.createMember(league);
    const queuedSecond = await factory.createMember(league);

    for (const member of [seatedA, seatedB, queuedFirst, queuedSecond]) {
      await factory.joinMatch(match, member);
    }

    const page = await asUser(queuedSecond.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);

    // Their own position, the confirmed names, and the queue's size — but not
    // who else is in it.
    await expect(page.getByText('Waitlisted — position 2')).toBeVisible();
    await expect(page.getByText(seatedA.firstName).first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText(queuedFirst.firstName);
  });
});

async function statusOf(
  factory: { query: <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]> },
  matchId: string,
  membershipId: string,
): Promise<string | undefined> {
  const rows = await factory.query<{ status: string }>(
    'select status::text from public.match_signups where match_id = $1 and membership_id = $2',
    [matchId, membershipId],
  );
  return rows[0]?.status;
}

async function confirmedCount(
  factory: { query: <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]> },
  matchId: string,
): Promise<number> {
  const rows = await factory.query<{ count: string }>(
    `select count(*)::text as count from public.match_signups
      where match_id = $1 and status = 'confirmed'`,
    [matchId],
  );
  return Number(rows[0]?.count ?? '0');
}

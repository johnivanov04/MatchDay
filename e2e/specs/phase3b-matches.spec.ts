import { expect, expectNoServerError, expectRedirectedTo, test } from '../support/fixtures';

/**
 * Phase 3 match publication and Phase 3B match editing.
 *
 * Parallel-safe: every test builds its own league and matches.
 */

test.describe('drafts and publication', () => {
  test('a draft is invisible to members, and publishing is idempotent', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const match = await factory.createMatch(league, { status: 'draft' });

    // A member cannot see the draft, by list or by direct link.
    const memberPage = await asUser(member.email);
    await memberPage.goto(`/leagues/${league.slug}/matches`);
    await expect(memberPage.locator('body')).not.toContainText(match.title);
    await expectRedirectedTo(
      memberPage,
      `/leagues/${league.slug}/matches/${match.id}`,
      '/dashboard',
    );

    // The administrator can, and publishes it.
    const adminPage = await asUser(league.admin.email);
    await adminPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(adminPage.getByText('Draft — members cannot see this match yet.')).toBeVisible();
    await adminPage.getByRole('button', { name: 'Publish to members' }).click();

    await expect
      .poll(async () => {
        const rows = await factory.query<{ status: string }>(
          'select status::text from public.matches where id = $1',
          [match.id],
        );
        return rows[0]?.status;
      })
      .toBe('open');

    // One notification per eligible member — and pressing publish again adds
    // none, because publication is idempotent by state.
    const countNotifications = async () => {
      const rows = await factory.query<{ count: string }>(
        `select count(*)::text as count from public.notifications
          where match_id = $1 and type = 'match_published'`,
        [match.id],
      );
      return rows[0]?.count;
    };
    expect(await countNotifications()).toBe('1');

    await adminPage.reload();
    const publishAgain = adminPage.getByRole('button', { name: 'Publish to members' });
    if ((await publishAgain.count()) > 0) {
      await publishAgain.click();
      await adminPage.waitForTimeout(500);
    }
    expect(await countNotifications()).toBe('1');

    // The member now sees it, with its real details.
    await memberPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(memberPage.getByRole('heading', { name: match.title })).toBeVisible();
    await expect(memberPage.getByText('E2E Pitch')).toBeVisible();
  });

  test('the published match appears in the member’s inbox with an unread badge', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const match = await factory.createMatch(league, { status: 'draft' });

    const adminPage = await asUser(league.admin.email);
    await adminPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await adminPage.getByRole('button', { name: 'Publish to members' }).click();
    await expect
      .poll(async () => {
        const rows = await factory.query<{ count: string }>(
          'select count(*)::text as count from public.notifications where match_id = $1',
          [match.id],
        );
        return rows[0]?.count;
      })
      .toBe('1');

    const memberPage = await asUser(member.email);
    await memberPage.goto('/notifications');
    await expect(memberPage.getByText(`New match: ${match.title}`)).toBeVisible();
    await expect(memberPage.getByText(/1 unread/)).toBeVisible();
  });

  test('a player has no administrator controls on a match', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const match = await factory.createMatch(league);

    const page = await asUser(member.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);

    await expect(page.getByRole('link', { name: 'Edit match' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Manage roster' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel this match' })).toHaveCount(0);
  });
});

test.describe('editing a draft', () => {
  test('is prefilled, saves, and stays invisible without notifying anybody', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const match = await factory.createMatch(league, { status: 'draft' });

    const page = await asUser(league.admin.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await page.getByRole('link', { name: 'Edit match' }).click();
    await expect(page.getByRole('heading', { name: 'Edit match' })).toBeVisible();

    // Prefilled from the stored match.
    await expect(page.getByLabel('Title')).toHaveValue(match.title);
    await expect(page.getByLabel('Location')).toHaveValue('E2E Pitch');

    await page.getByLabel('Title').fill('Renamed draft');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.waitForURL(new RegExp(`/matches/${match.id}`));

    await expect(page.getByRole('heading', { name: 'Renamed draft' })).toBeVisible();

    // Still a draft, still invisible, and nobody was told.
    const notifications = await factory.query<{ count: string }>(
      'select count(*)::text as count from public.notifications where match_id = $1',
      [match.id],
    );
    expect(notifications[0]?.count).toBe('0');

    const memberPage = await asUser(member.email);
    await expectRedirectedTo(
      memberPage,
      `/leagues/${league.slug}/matches/${match.id}`,
      '/dashboard',
    );
  });

  test('saving without changing anything does not move the match', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { status: 'draft' });

    const before = await factory.query<{ kickoff: string; arrival: string }>(
      'select kickoff_at::text as kickoff, arrival_at::text as arrival from public.matches where id = $1',
      [match.id],
    );

    const page = await asUser(league.admin.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}/edit`);
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.waitForURL(new RegExp(`/matches/${match.id}`));

    const after = await factory.query<{ kickoff: string; arrival: string }>(
      'select kickoff_at::text as kickoff, arrival_at::text as arrival from public.matches where id = $1',
      [match.id],
    );

    // The round trip through the league's zone is the identity. A drift here
    // would move every match by an hour on every save.
    expect(after[0]?.kickoff).toBe(before[0]?.kickoff);
    expect(after[0]?.arrival).toBe(before[0]?.arrival);
  });

  test('round-trips a match that sits on a daylight-saving transition', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague({ timezone: 'America/Los_Angeles' });
    const match = await factory.createMatch(league, { status: 'draft' });

    // 8 March 2026 is the day the clocks go forward in Los Angeles — the case
    // that used to shift by an hour on every save.
    await factory.query(
      `update public.matches
          set match_date = date '2026-03-08',
              arrival_at = (date '2026-03-08' + time '18:30') at time zone timezone,
              kickoff_at = (date '2026-03-08' + time '19:00') at time zone timezone,
              end_at     = (date '2026-03-08' + time '20:30') at time zone timezone,
              signup_closes_at = (date '2026-03-08' + time '17:00') at time zone timezone,
              cancellation_cutoff_at = (date '2026-03-07' + time '19:00') at time zone timezone,
              priority_window_ends_at = null
        where id = $1`,
      [match.id],
    );

    const page = await asUser(league.admin.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}/edit`);

    // The form shows the local wall-clock time, not a UTC instant.
    await expect(page.getByLabel('Kickoff')).toHaveValue('19:00');

    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.waitForURL(new RegExp(`/matches/${match.id}`));

    const after = await factory.query<{ local: string }>(
      `select to_char(kickoff_at at time zone timezone, 'HH24:MI') as local
         from public.matches where id = $1`,
      [match.id],
    );
    expect(after[0]?.local).toBe('19:00');
  });
});

test.describe('editing a published match', () => {
  test('exposes only the permitted fields and notifies members once', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const match = await factory.createMatch(league, { status: 'open' });

    const page = await asUser(league.admin.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}/edit`);

    // Participation terms are absent after publication: members agreed to them.
    await expect(page.getByLabel('How spots are filled')).toHaveCount(0);
    await expect(page.getByLabel('How the waitlist moves')).toHaveCount(0);

    // And the warning is explicit about the consequence.
    await expect(page.getByText(/notifies every active member/)).toBeVisible();

    await page.getByLabel('Location', { exact: true }).fill('Riverside Pitch');
    await page.getByRole('button', { name: 'Save and notify members' }).click();
    await page.waitForURL(new RegExp(`/matches/${match.id}`));

    // Polled: the redirect lands before this separate connection can observe
    // the committed row.
    await expect
      .poll(async () => {
        const rows = await factory.query<{ revision: number }>(
          'select revision from public.matches where id = $1',
          [match.id],
        );
        return rows[0]?.revision;
      })
      .toBe(1);

    const rows = await factory.query<{ location: string }>(
      'select location_name as location from public.matches where id = $1',
      [match.id],
    );
    expect(rows[0]?.location).toBe('Riverside Pitch');

    // Exactly one match_changed notification for the one eligible member.
    const notifications = await factory.query<{ count: string }>(
      `select count(*)::text as count from public.notifications
        where match_id = $1 and type = 'match_changed'`,
      [match.id],
    );
    expect(notifications[0]?.count).toBe('1');

    const memberPage = await asUser(member.email);
    await memberPage.goto('/notifications');
    // Unanchored: an unread row renders a bullet before the title.
    await expect(memberPage.getByText(/Updated: /)).toBeVisible();
  });

  test('a stale second save is refused rather than silently overwriting', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { status: 'open' });

    const page = await asUser(league.admin.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}/edit`);

    // Somebody else edits while this form is open.
    await factory.query(
      `select public.set_config('x', 'x', false)`, // no-op, keeps the shape obvious
    ).catch(() => undefined);
    await factory.query('update public.matches set revision = revision + 1 where id = $1', [
      match.id,
    ]);

    await page.getByLabel('Title').fill('My stale change');
    await page.getByRole('button', { name: 'Save and notify members' }).click();

    // The form reports the conflict; nothing is overwritten.
    await expect(page.getByRole('alert').first()).toContainText(/Reload/i);
    await expectNoServerError(page);

    const rows = await factory.query<{ title: string }>(
      'select title from public.matches where id = $1',
      [match.id],
    );
    expect(rows[0]?.title).toBe(match.title);
  });
});

test('a canceled match cannot be edited, by button or by URL', async ({ factory, asUser }) => {
  const league = await factory.createLeague();
  const match = await factory.createMatch(league, { status: 'open' });

  const page = await asUser(league.admin.email);
  await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
  await page.getByRole('button', { name: 'Cancel this match' }).click();

  await expect
    .poll(async () => {
      const rows = await factory.query<{ status: string }>(
        'select status::text from public.matches where id = $1',
        [match.id],
      );
      return rows[0]?.status;
    })
    .toBe('canceled');

  await page.reload();
  await expect(page.getByRole('link', { name: 'Edit match' })).toHaveCount(0);
  await expect(page.getByText(/This match was canceled/)).toBeVisible();

  // The direct URL redirects back to the match rather than erroring.
  await page.goto(`/leagues/${league.slug}/matches/${match.id}/edit`);
  await expect(page).toHaveURL(/notice=not-editable/);
  await expectNoServerError(page);
});

test('administrator notes are never visible to a player', async ({ factory, asUser }) => {
  const league = await factory.createLeague();
  const member = await factory.createMember(league);
  const match = await factory.createMatch(league, { status: 'open' });

  const adminPage = await asUser(league.admin.email);
  await adminPage.goto(`/leagues/${league.slug}/matches/${match.id}/edit`);
  await adminPage.getByLabel('Private notes').fill('CONFIDENTIAL-E2E-NOTE');
  await adminPage.getByRole('button', { name: /save notes/i }).click();
  await adminPage.waitForURL(new RegExp(`/matches/${match.id}`));

  await expect(adminPage.getByText('CONFIDENTIAL-E2E-NOTE')).toBeVisible();

  const memberPage = await asUser(member.email);
  await memberPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
  await expect(memberPage.locator('body')).not.toContainText('CONFIDENTIAL-E2E-NOTE');

  // Nor through the notification a member can receive about this match.
  await memberPage.goto('/notifications');
  await expect(memberPage.locator('body')).not.toContainText('CONFIDENTIAL-E2E-NOTE');
});

test('a cross-league administrator cannot open the edit route', async ({ factory, asUser }) => {
  const mine = await factory.createLeague();
  const theirs = await factory.createLeague();
  const match = await factory.createMatch(theirs, { status: 'open' });

  const page = await asUser(mine.admin.email);
  await expectRedirectedTo(
    page,
    `/leagues/${theirs.slug}/matches/${match.id}/edit`,
    '/dashboard',
  );
});

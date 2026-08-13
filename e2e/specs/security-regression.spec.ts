import { expect, expectNoServerError, test, settledUrl } from '../support/fixtures';

/**
 * Cross-phase authorization and leakage regression.
 *
 * The rule these all defend, learned three times over Phases 1–3B: an expected
 * authorization outcome must produce a clean redirect, never an unhandled
 * `DomainError` escaping a Server Component — which Next.js reports to the user
 * as a 500 even though the application behaved correctly.
 *
 * Parallel-safe.
 */

test.describe('routes refuse the wrong caller, without erroring', () => {
  test('a player is refused every administrator route in their own league', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league);
    const member = await factory.createMember(league);
    const page = await asUser(member.email);

    const adminRoutes = [
      `/leagues/${league.slug}/settings`,
      `/leagues/${league.slug}/members`,
      `/leagues/${league.slug}/templates`,
      `/leagues/${league.slug}/matches/new`,
      `/leagues/${league.slug}/guidelines/manage`,
      `/leagues/${league.slug}/matches/${match.id}/edit`,
      `/leagues/${league.slug}/matches/${match.id}/roster`,
    ];

    for (const route of adminRoutes) {
      const response = await page.goto(route);
      expect(response?.status() ?? 200, `status for ${route}`).toBeLessThan(500);
      await expect(page, `landing for ${route}`).toHaveURL(/\/dashboard/);
      await expectNoServerError(page);
    }
  });

  test('a cross-league administrator is refused every route of another league', async ({
    factory,
    asUser,
  }) => {
    const mine = await factory.createLeague();
    const theirs = await factory.createLeague();
    const match = await factory.createMatch(theirs);
    const page = await asUser(mine.admin.email);

    const routes = [
      `/leagues/${theirs.slug}/settings`,
      `/leagues/${theirs.slug}/members`,
      `/leagues/${theirs.slug}/matches`,
      `/leagues/${theirs.slug}/guidelines`,
      `/leagues/${theirs.slug}/matches/${match.id}`,
      `/leagues/${theirs.slug}/matches/${match.id}/edit`,
      `/leagues/${theirs.slug}/matches/${match.id}/roster`,
    ];

    for (const route of routes) {
      const response = await page.goto(route);
      expect(response?.status() ?? 200, `status for ${route}`).toBeLessThan(500);
      await expect(page, `landing for ${route}`).toHaveURL(/\/dashboard/);
    }
  });

  test('a non-member cannot open a private league’s match', async ({ factory, asUser }) => {
    const league = await factory.createLeague({ visibility: 'private' });
    const match = await factory.createMatch(league);
    const outsider = await factory.createOutsider();

    const page = await asUser(outsider.email);
    const response = await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    expect(response?.status() ?? 200).toBeLessThan(500);
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('a removed member loses access immediately', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league);
    const member = await factory.createMember(league);

    const page = await asUser(member.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(page.getByRole('heading', { name: match.title })).toBeVisible();

    await factory.query(
      `update public.league_memberships set status = 'removed' where id = $1`,
      [member.membershipId],
    );

    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(page).toHaveURL(/\/dashboard/);
    await expectNoServerError(page);
  });
});

test.describe('identifiers reveal nothing', () => {
  test('a wrong slug with a valid match id answers as a wrong slug alone', async ({
    factory,
    asUser,
  }) => {
    const home = await factory.createLeague();
    const elsewhere = await factory.createLeague();
    const match = await factory.createMatch(elsewhere);
    const member = await factory.createMember(home);

    const page = await asUser(member.email);

    // The caller's own league, but a match id from another one.
    const crossLeague = await settledUrl(page, `/leagues/${home.slug}/matches/${match.id}`);

    // A match id that does not exist anywhere.
    const unknown = await settledUrl(
      page,
      `/leagues/${home.slug}/matches/aaaaaaaa-aaaa-4aaa-8aaa-0000000000ff`,
    );

    expect(crossLeague).toBe(unknown);
    await expectNoServerError(page);
  });

  test('a malformed match id does not produce a server error', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);

    const page = await asUser(member.email);
    const response = await page.goto(`/leagues/${league.slug}/matches/not-a-uuid`);

    expect(response?.status() ?? 200).toBeLessThan(500);
    await expectNoServerError(page);
  });

  test('a draft match is indistinguishable from one that does not exist', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const draft = await factory.createMatch(league, { status: 'draft' });
    const member = await factory.createMember(league);

    const page = await asUser(member.email);

    const draftUrl = await settledUrl(page, `/leagues/${league.slug}/matches/${draft.id}`);
    const unknownUrl = await settledUrl(
      page,
      `/leagues/${league.slug}/matches/aaaaaaaa-aaaa-4aaa-8aaa-0000000000fe`,
    );

    expect(draftUrl).toBe(unknownUrl);
  });
});

test.describe('private data stays private', () => {
  test('a player never sees the waitlist, administrator notes or a cancellation reason', async ({
    factory,
    asUser,
  }) => {
    // Administrator-controlled, so the cancellation below opens a spot without
    // promoting anybody — leaving somebody genuinely on the waitlist for the
    // observer to fail to see.
    const league = await factory.createLeague({ waitlistMode: 'admin_controlled' });
    const match = await factory.createMatch(league, {
      capacity: 2,
      waitlistMode: 'admin_controlled',
    });

    const seatedA = await factory.createMember(league);
    const seatedB = await factory.createMember(league);
    const queuedFirst = await factory.createMember(league);
    const observer = await factory.createMember(league);
    for (const member of [seatedA, seatedB, queuedFirst, observer]) {
      await factory.joinMatch(match, member);
    }

    // An administrator note and a cancellation with a reason.
    await factory.callAs(
      league.admin,
      `insert into public.match_admin_notes (match_id, league_id, notes)
       values ($1, $2, 'ADMIN-ONLY-NOTE')
       on conflict (match_id) do update set notes = excluded.notes`,
      [match.id, league.id],
    );
    await factory.callAs(seatedA, 'select public.cancel_spot($1, $2)', [
      match.id,
      'PRIVATE-CANCELLATION-REASON',
    ]);

    const page = await asUser(observer.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);

    const body = page.locator('body');
    await expect(body).not.toContainText('ADMIN-ONLY-NOTE');
    await expect(body).not.toContainText('PRIVATE-CANCELLATION-REASON');
    // The queue's size is fine to know; who is in it is not.
    await expect(body).not.toContainText(`${queuedFirst.firstName} Tester`);

    await page.goto('/notifications');
    await expect(page.locator('body')).not.toContainText('ADMIN-ONLY-NOTE');
    await expect(page.locator('body')).not.toContainText('PRIVATE-CANCELLATION-REASON');
  });

  test('another player’s private profile fields never appear on a roster', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague({ genderFieldEnabled: true });
    const match = await factory.createMatch(league, { capacity: 4 });
    const playing = await factory.createMember(league);
    const observer = await factory.createMember(league);
    await factory.joinMatch(match, playing);

    await factory.query(
      `update public.profiles set phone = '+15550001111', gender = 'PRIVATE-GENDER-VALUE'
        where id = $1`,
      [playing.id],
    );

    const page = await asUser(observer.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);

    // The roster is names only — the projection has no column for anything else.
    await expect(page.getByText(playing.firstName).first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText('+15550001111');
    await expect(page.locator('body')).not.toContainText('PRIVATE-GENDER-VALUE');
  });

  test('a private league cannot be found by probing discovery', async ({ factory, asUser }) => {
    const priv = await factory.createLeague({ visibility: 'private' });
    const outsider = await factory.createOutsider();

    const page = await asUser(outsider.email);
    await page.goto('/leagues/discover');

    // Neither by its exact name nor by its area.
    for (const query of [priv.name, 'E2E Area']) {
      await page.getByLabel('Search by name or area').fill(query);
      await page.getByRole('button', { name: 'Search' }).click();
      await expect(page.locator('li').filter({ hasText: priv.name })).toHaveCount(0);
    }
  });
});

test('signed-out visitors are sent to sign in from every authenticated route', async ({
  factory,
  page,
}) => {
  const league = await factory.createLeague();
  const match = await factory.createMatch(league);

  const routes = [
    '/dashboard',
    '/profile',
    '/notifications',
    '/settings/devices',
    '/leagues/discover',
    `/leagues/${league.slug}/matches`,
    `/leagues/${league.slug}/matches/${match.id}`,
    `/leagues/${league.slug}/settings`,
  ];

  for (const route of routes) {
    const response = await page.goto(route);
    expect(response?.status() ?? 200, `status for ${route}`).toBeLessThan(500);
    await expect(page, `landing for ${route}`).toHaveURL(/\/sign-in/);
  }
});

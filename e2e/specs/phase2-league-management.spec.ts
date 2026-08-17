import { expect, expectNoServerError, expectRedirectedTo, test, settledUrl } from '../support/fixtures';

/**
 * Phase 2 — league creation, discovery, join requests, invitations, member
 * management and administration transfer.
 *
 * Parallel-safe: every test builds its own leagues and members.
 */

test.describe('creating a league', () => {
  test('a new league is private and its settings persist', async ({ factory, asUser }) => {
    const outsider = await factory.createOutsider();
    const page = await asUser(outsider.email);

    await page.goto('/leagues/new');
    const suffix = Date.now().toString(36);

    await page.getByLabel('League name').fill(`Created ${suffix}`);
    await page.getByLabel('League address').fill(`created-${suffix}`);
    await page.getByLabel('Short description').fill('A league made by the end-to-end suite.');
    await page.getByLabel('General area').fill('Testville');
    await page.getByLabel('Sport or format').fill('Soccer 7v7');
    await page.getByLabel('Capacity').fill('14');
    await page.getByLabel('Minimum players', { exact: true }).fill('8');

    await page.getByRole('button', { name: 'Create league' }).click();
    await page.waitForURL(/\/leagues\/created-/);

    // PRD §6: new leagues are private, and the creator is the administrator.
    const [league] = await factory.query<{ visibility: string; default_capacity: number }>(
      'select visibility, default_capacity from public.leagues where slug = $1',
      [`created-${suffix}`],
    );
    expect(league?.visibility).toBe('private');
    expect(league?.default_capacity).toBe(14);

    await page.goto(`/leagues/created-${suffix}/settings`);
    await expect(page.getByLabel('Capacity')).toHaveValue('14');
  });

  test('a duplicate league address is refused in the form', async ({ factory, asUser }) => {
    const existing = await factory.createLeague();
    const outsider = await factory.createOutsider();
    const page = await asUser(outsider.email);

    await page.goto('/leagues/new');
    await page.getByLabel('League name').fill('Clashing league');
    await page.getByLabel('League address').fill(existing.slug);
    await page.getByLabel('Short description').fill('This address is already taken.');
    await page.getByLabel('General area').fill('Testville');
    await page.getByLabel('Sport or format').fill('Soccer');
    await page.getByRole('button', { name: 'Create league' }).click();

    await expect(page.getByRole('alert').first()).toBeVisible();
    await expectNoServerError(page);
  });
});

test.describe('discovery', () => {
  test('a private league never appears in search', async ({ factory, asUser }) => {
    const priv = await factory.createLeague({ visibility: 'private' });
    const outsider = await factory.createOutsider();

    const page = await asUser(outsider.email);
    await page.goto('/leagues/discover');
    await page.getByLabel('Search by name or area').fill(priv.name);
    await page.getByRole('button', { name: 'Search' }).click();

    // The query is echoed back in the "no matches" message, so absence of the
    // *name* is the wrong assertion. What must be absent is any result: no card
    // and no way to act on one.
    await expect(page.getByText(/No searchable leagues match/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Request to join' })).toHaveCount(0);
  });

  test('a searchable league appears, showing only the approved public fields', async ({
    factory,
    asUser,
  }) => {
    const open = await factory.createLeague({ visibility: 'searchable' });
    const member = await factory.createMember(open);
    const outsider = await factory.createOutsider();

    const page = await asUser(outsider.email);
    await page.goto('/leagues/discover');
    await page.getByLabel('Search by name or area').fill(open.name);
    await page.getByRole('button', { name: 'Search' }).click();

    await expect(page.getByText(open.name)).toBeVisible();
    await expect(page.getByText('E2E Area')).toBeVisible();

    // 04 §3: no member names, no roster, no contact details in a public result.
    await expect(page.locator('body')).not.toContainText(member.firstName);
    await expect(page.locator('body')).not.toContainText(member.email);
  });
});

test.describe('join requests', () => {
  test('a request is created once, approved, and produces exactly one membership', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague({ visibility: 'searchable' });
    const applicant = await factory.createOutsider();

    const applicantPage = await asUser(applicant.email);
    await applicantPage.goto('/leagues/discover');
    await applicantPage.getByLabel('Search by name or area').fill(league.name);
    await applicantPage.getByRole('button', { name: 'Search' }).click();
    // Two steps by design: the card offers a quiet "Request to join", which
    // reveals the optional note to the administrator and the confirm. A result
    // list of eight leagues is not eight primary actions.
    await applicantPage.getByRole('button', { name: 'Request to join' }).click();
    await applicantPage.getByRole('button', { name: 'Send request' }).click();
    await expect(applicantPage.getByText('Request sent — awaiting approval.')).toBeVisible();

    // A second attempt must not create a second request.
    await applicantPage.reload();
    await applicantPage.getByLabel('Search by name or area').fill(league.name);
    await applicantPage.getByRole('button', { name: 'Search' }).click();
    await expect(applicantPage.getByText('Request sent — awaiting approval.')).toBeVisible();

    const requests = await factory.query<{ count: string }>(
      `select count(*)::text as count from public.league_join_requests
        where league_id = $1 and user_id = $2 and status = 'pending'`,
      [league.id, applicant.id],
    );
    expect(requests[0]?.count).toBe('1');

    const adminPage = await asUser(league.admin.email);
    await adminPage.goto(`/leagues/${league.slug}/members`);

    // The applicant's *name* is deliberately not shown: an administrator may
    // read the profiles of their own members, and somebody with only a pending
    // request is not one yet. The request itself is what appears.
    await expect(adminPage.getByRole('button', { name: 'Approve' })).toHaveCount(1);

    await adminPage.getByRole('button', { name: 'Approve' }).first().click();
    await expect(adminPage.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    // Now they are a member, so their name is readable.
    await expect(adminPage.getByText(applicant.firstName).first()).toBeVisible();

    const memberships = await factory.query<{ count: string; status: string }>(
      `select count(*)::text as count, max(status::text) as status
         from public.league_memberships where league_id = $1 and user_id = $2`,
      [league.id, applicant.id],
    );
    expect(memberships[0]?.count).toBe('1');
    expect(memberships[0]?.status).toBe('active');
  });

  test('a rejected applicant does not gain member access', async ({ factory, asUser }) => {
    const league = await factory.createLeague({ visibility: 'searchable' });
    const applicant = await factory.createOutsider();

    await factory.query(
      `insert into public.league_join_requests (league_id, user_id, status)
       values ($1, $2, 'pending')`,
      [league.id, applicant.id],
    );

    const adminPage = await asUser(league.admin.email);
    await adminPage.goto(`/leagues/${league.slug}/members`);
    await adminPage.getByRole('button', { name: 'Reject' }).first().click();
    await expect(adminPage.getByRole('button', { name: 'Reject' })).toHaveCount(0);

    const applicantPage = await asUser(applicant.email);
    await expectRedirectedTo(applicantPage, `/leagues/${league.slug}/matches`, '/dashboard');
  });
});

test.describe('invitations', () => {
  test('an invite is created, redeemed once, and redeeming again is harmless', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const guest = await factory.createOutsider();

    const adminPage = await asUser(league.admin.email);
    await adminPage.goto(`/leagues/${league.slug}/members`);
    await adminPage.getByLabel('Label').fill('E2E invite');
    await adminPage.getByRole('button', { name: 'Create invitation link' }).click();

    const linkField = adminPage.getByLabel('Invitation link');
    await expect(linkField).toBeVisible();
    const url = await linkField.inputValue();
    expect(url).toContain('/invite/');

    const guestPage = await asUser(guest.email);
    await guestPage.goto(new URL(url).pathname);
    await guestPage.getByRole('button', { name: 'Accept invitation' }).click();
    // Redemption renders in place rather than redirecting: nothing about the
    // league may be shown until it has succeeded.
    await expect(guestPage.getByRole('heading', { name: 'You are in.' })).toBeVisible();

    // Redeeming the same link twice must not create a second membership, and
    // must say so rather than pretending it just worked.
    await guestPage.goto(new URL(url).pathname);
    await guestPage.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(
      guestPage.getByRole('heading', { name: 'You already belong to this league.' }),
    ).toBeVisible();
    await expectNoServerError(guestPage);

    const memberships = await factory.query<{ count: string }>(
      `select count(*)::text as count from public.league_memberships
        where league_id = $1 and user_id = $2`,
      [league.id, guest.id],
    );
    expect(memberships[0]?.count).toBe('1');
  });

  test('a revoked invite stops working, and says nothing about the league', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const guest = await factory.createOutsider();

    const adminPage = await asUser(league.admin.email);
    await adminPage.goto(`/leagues/${league.slug}/members`);
    await adminPage.getByRole('button', { name: 'Create invitation link' }).click();
    const url = await adminPage.getByLabel('Invitation link').inputValue();

    await adminPage.getByRole('button', { name: 'Revoke' }).first().click();
    await expect(adminPage.getByRole('button', { name: 'Revoke' })).toHaveCount(0);

    const guestPage = await asUser(guest.email);
    await guestPage.goto(new URL(url).pathname);
    await expectNoServerError(guestPage);
    // A revoked, expired and forged link all read the same.
    await expect(guestPage.locator('body')).not.toContainText(league.name);
  });

  test('a nonsense invite token gives a safe answer', async ({ factory, asUser }) => {
    const guest = await factory.createOutsider();
    const page = await asUser(guest.email);

    await page.goto('/invite/not-a-real-token-at-all');
    await expectNoServerError(page);
    await expect(page.locator('body')).toContainText(/not valid|expired/i);
  });
});

test.describe('member management', () => {
  test('an administrator adds an existing account by email', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const stranger = await factory.createOutsider();

    const page = await asUser(league.admin.email);
    await page.goto(`/leagues/${league.slug}/members`);
    await page.getByLabel('Email address').fill(stranger.email);
    await page.getByRole('button', { name: 'Add member' }).click();
    await expect(page.getByText('Member added.')).toBeVisible();

    const memberships = await factory.query<{ status: string }>(
      `select status::text from public.league_memberships
        where league_id = $1 and user_id = $2`,
      [league.id, stranger.id],
    );
    expect(memberships[0]?.status).toBe('active');
  });

  test('adding an address with no account fails in the form, not with a 500', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const page = await asUser(league.admin.email);

    await page.goto(`/leagues/${league.slug}/members`);
    await page.getByLabel('Email address').fill('nobody.at.all@matchday.test');
    await page.getByRole('button', { name: 'Add member' }).click();

    await expect(page.getByRole('alert').first()).toBeVisible();
    await expectNoServerError(page);
  });
});

/**
 * Administration transfer.
 *
 * Serial within the describe: each test owns its league end to end, but the
 * transfer changes who may see what, so the steps inside a single test must run
 * in order.
 */
test.describe('administration transfer', () => {
  test('transfers atomically and redirects the former administrator', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const successor = await factory.createMember(league);

    const adminPage = await asUser(league.admin.email);
    await adminPage.goto(`/leagues/${league.slug}/members`);

    await adminPage.getByLabel('New administrator').selectOption(successor.membershipId);
    await adminPage.getByLabel('Type “transfer” to confirm').fill('transfer');
    await adminPage.getByRole('button', { name: /transfer administration/i }).click();

    // The action redirects, because the caller has just lost this route.
    await adminPage.waitForURL(/\/dashboard/);
    await expect(adminPage.locator('body')).toContainText('Administration transferred');

    const roles = await factory.query<{ user_id: string; role: string }>(
      `select user_id, role::text from public.league_memberships
        where league_id = $1 order by role`,
      [league.id],
    );
    expect(roles.find((row) => row.user_id === successor.id)?.role).toBe('league_admin');
    expect(roles.find((row) => row.user_id === league.admin.id)?.role).toBe('player');

    // The former administrator is now refused, cleanly.
    await expectRedirectedTo(adminPage, `/leagues/${league.slug}/settings`, '/dashboard');
    await expectNoServerError(adminPage);

    // And the successor can administer.
    const successorPage = await asUser(successor.email);
    await successorPage.goto(`/leagues/${league.slug}/settings`);
    await expect(successorPage.getByRole('heading', { name: 'League settings' })).toBeVisible();
  });

  test('a failed transfer leaves the original administrator in place', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const successor = await factory.createMember(league);

    const page = await asUser(league.admin.email);
    await page.goto(`/leagues/${league.slug}/members`);

    // The confirmation word is deliberately wrong.
    await page.getByLabel('New administrator').selectOption(successor.membershipId);
    await page.getByLabel('Type “transfer” to confirm').fill('yes please');
    await page.getByRole('button', { name: /transfer administration/i }).click();

    await expect(page.getByRole('alert').first()).toBeVisible();
    await expectNoServerError(page);

    const roles = await factory.query<{ role: string }>(
      `select role::text from public.league_memberships
        where league_id = $1 and user_id = $2`,
      [league.id, league.admin.id],
    );
    expect(roles[0]?.role).toBe('league_admin');
  });
});

test('a cross-league administrator is refused, exactly as a stranger is', async ({
  factory,
  asUser,
}) => {
  const mine = await factory.createLeague();
  const theirs = await factory.createLeague();

  const page = await asUser(mine.admin.email);

  const crossLeagueUrl = await settledUrl(page, `/leagues/${theirs.slug}/settings`);
  const unknownUrl = await settledUrl(page, '/leagues/not-a-league-at-all/settings');

  expect(crossLeagueUrl).toBe(unknownUrl);
  await expectNoServerError(page);
});

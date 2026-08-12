import { expect, expectNoServerError, expectRedirectedTo, test } from '../support/fixtures';

/**
 * Phase 1 — authentication, profile and the multi-league foundation.
 *
 * Parallel-safe: every test builds its own leagues and members.
 */

test('a signed-in member reaches the dashboard and sees their own name', async ({
  factory,
  asUser,
}) => {
  const league = await factory.createLeague();
  const member = await factory.createMember(league);

  const page = await asUser(member.email);
  await page.goto('/dashboard');

  await expect(page.getByRole('heading', { name: `Hello, ${member.firstName}` })).toBeVisible();
  await expect(page.getByText(league.name).first()).toBeVisible();
});

test('an anonymous visitor is sent to sign in rather than to an error', async ({ page }) => {
  await expectRedirectedTo(page, '/dashboard', '/sign-in');
  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
});

test('the profile page loads the global profile', async ({ factory, asUser }) => {
  const league = await factory.createLeague();
  const member = await factory.createMember(league);

  const page = await asUser(member.email);
  await page.goto('/profile');

  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible();
  await expect(page.getByLabel('First name')).toHaveValue(member.firstName);
});

test('a profile edit persists across a reload', async ({ factory, asUser }) => {
  const league = await factory.createLeague();
  const member = await factory.createMember(league);

  const page = await asUser(member.email);
  await page.goto('/profile');

  await page.getByLabel('Last name').fill('Renamed');
  await page.getByRole('button', { name: /save/i }).click();
  await expect(page.getByRole('status').first()).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Last name')).toHaveValue('Renamed');
});

test.describe('multi-league membership', () => {
  test('somebody in two leagues sees both, and switching changes the active one', async ({
    factory,
    asUser,
  }) => {
    // The tenancy property, from the seeded fixture that exists for it: one
    // person, two leagues, and the app must keep them apart.
    const first = await factory.createLeague();
    const second = await factory.createLeague();
    const member = await factory.createMember(first);

    // The same person joins the second league.
    await factory.query(
      `insert into public.league_memberships (league_id, user_id, role, status)
       values ($1, $2, 'player', 'active')`,
      [second.id, member.id],
    );

    const page = await asUser(member.email);
    await page.goto('/dashboard');

    // Both memberships are offered. Asserting on the options rather than on
    // page text, because an <option> is never "visible" to Playwright.
    const switcher = page.getByLabel('Active league');
    await expect(switcher.locator('option')).toHaveCount(2);
    await expect(switcher.locator('option', { hasText: first.name })).toHaveCount(1);
    await expect(switcher.locator('option', { hasText: second.name })).toHaveCount(1);

    // Switching is a real form post that writes `user_app_state`. Asserting on
    // the stored row rather than on the select immediately after the click: the
    // control's value comes from a fresh server render, so reading it straight
    // away races the revalidation.
    await switcher.selectOption(second.id);
    await page.getByRole('button', { name: 'Switch' }).click();

    await expect
      .poll(async () => {
        const rows = await factory.query<{ active: string | null }>(
          'select active_league_id as active from public.user_app_state where user_id = $1',
          [member.id],
        );
        return rows[0]?.active;
      })
      .toBe(second.id);

    await page.reload();
    // The choice survives a reload, which is the whole point of persisting it
    // server-side rather than in the browser.
    await expect(page.getByLabel('Active league')).toHaveValue(second.id);
  });

  test('a league A member cannot read league B pages', async ({ factory, asUser }) => {
    const leagueA = await factory.createLeague();
    const leagueB = await factory.createLeague();
    const member = await factory.createMember(leagueA);

    const page = await asUser(member.email);

    // Not a member of B at all: the guard redirects rather than throwing.
    await expectRedirectedTo(page, `/leagues/${leagueB.slug}/matches`, '/dashboard');
    await expect(page.locator('body')).toContainText('active members');
  });

  test('a player cannot open administrator-only routes in their own league', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const page = await asUser(member.email);

    for (const path of ['settings', 'members', 'matches/new', 'templates']) {
      await expectRedirectedTo(page, `/leagues/${league.slug}/${path}`, '/dashboard');
      await expect(page.locator('body')).toContainText('league administrator');
    }
  });
});

test('somebody with no memberships sees an empty state, not an error', async ({
  factory,
  asUser,
}) => {
  const outsider = await factory.createOutsider();
  const page = await asUser(outsider.email);

  await page.goto('/dashboard');
  await expectNoServerError(page);
  await expect(page.getByRole('heading', { name: /Hello,/ })).toBeVisible();
  // No league is named, because they belong to none.
  await expect(page.getByRole('link', { name: /Find a league/i }).first()).toBeVisible();
});

test('a pending member cannot reach member-only content', async ({ factory, asUser }) => {
  const league = await factory.createLeague();
  const pending = await factory.createMember(league, { status: 'pending' });

  const page = await asUser(pending.email);
  await expectRedirectedTo(page, `/leagues/${league.slug}/matches`, '/dashboard');
});

test('a suspended member cannot reach member-only content', async ({ factory, asUser }) => {
  const league = await factory.createLeague();
  const suspended = await factory.createMember(league, { status: 'suspended' });

  const page = await asUser(suspended.email);
  await expectRedirectedTo(page, `/leagues/${league.slug}/matches`, '/dashboard');
});

test('an unknown league slug answers exactly as one the caller may not see', async ({
  factory,
  asUser,
}) => {
  const league = await factory.createLeague();
  const other = await factory.createLeague();
  const member = await factory.createMember(league);

  const page = await asUser(member.email);

  await page.goto('/leagues/definitely-not-a-real-league/matches');
  const unknownUrl = page.url();

  await page.goto(`/leagues/${other.slug}/matches`);
  const forbiddenUrl = page.url();

  // Identical, so a guessed slug cannot confirm a private league exists.
  expect(unknownUrl).toBe(forbiddenUrl);
  await expectNoServerError(page);
});

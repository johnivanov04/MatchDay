import { expect, expectNoServerError, test } from '../support/fixtures';

/**
 * The safety controls App Review has to be able to watch somebody use.
 *
 * Guideline 1.2 asks for reporting and blocking that members can actually
 * reach. Everything here is a click path a reviewer could follow on a device
 * without being told a URL — which is the difference between a control that
 * exists and one that counts.
 *
 * Parallel-safe: every test creates its own league and its own members.
 */

test.describe('safety controls', () => {
  test('a member reaches blocked members from their profile, by clicking', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const alice = await factory.createMember(league);
    const page = await asUser(alice.email);

    await page.goto('/profile');
    await expectNoServerError(page);

    // No URL typed: the reviewer finds it the way a member would.
    await page.getByRole('link', { name: /Blocked members/i }).click();

    await expect(page.getByRole('heading', { name: 'Blocked members' })).toBeVisible();
    await expect(page.getByText(/have not blocked anyone/i)).toBeVisible();
  });

  test('a member reports and blocks another member from a roster, and can undo it', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 8 });
    const alice = await factory.createMember(league);
    const bob = await factory.createMember(league);

    await factory.joinMatch(match, alice);
    await factory.joinMatch(match, bob);

    const alicePage = await asUser(alice.email);
    await alicePage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expectNoServerError(alicePage);

    // Re-resolved before each interaction rather than captured once: submitting
    // the report re-renders the row, and a locator held across that change
    // points at a node the page has replaced.
    const bobRow = () =>
      alicePage
        .getByRole('listitem')
        .filter({ hasText: `${bob.firstName} ${bob.lastName}` })
        .first();

    // ── Reporting ────────────────────────────────────────────────────────
    await bobRow().getByRole('button', { name: 'Report' }).click();
    await alicePage.getByRole('radio', { name: /Harassment or bullying/i }).check();
    await alicePage.getByRole('button', { name: 'Send report' }).click();

    // The confirmation says the thing people are worried about before they press it.
    await expect(alicePage.getByText(/not told who reported them/i)).toBeVisible();

    // ── Blocking ─────────────────────────────────────────────────────────
    await bobRow().getByRole('button', { name: 'Block', exact: true }).click();
    // Wait for the write to land before reloading, rather than racing it.
    await expect(alicePage.getByRole('button', { name: 'Unblock' })).toBeVisible();

    await alicePage.reload();
    // Bob's name is gone from Alice's view of the roster.
    await expect(alicePage.getByText(`${bob.firstName} ${bob.lastName}`)).toHaveCount(0);
    await expect(alicePage.getByText(/Blocked member/i).first()).toBeVisible();

    // ── Undoing it ───────────────────────────────────────────────────────
    await alicePage.goto('/profile');
    await alicePage.getByRole('link', { name: /Blocked members/i }).click();
    await expect(alicePage.getByText(`${bob.firstName} ${bob.lastName}`)).toBeVisible();

    await alicePage.getByRole('button', { name: 'Unblock' }).first().click();
    await expect(alicePage.getByText(/have not blocked anyone/i)).toBeVisible();

    // And the roster is whole again.
    await alicePage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(
      alicePage.getByText(`${bob.firstName} ${bob.lastName}`).first(),
    ).toBeVisible();
  });

  test('a blocked member does not learn they were blocked', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 8 });
    const alice = await factory.createMember(league);
    const bob = await factory.createMember(league);

    await factory.joinMatch(match, alice);
    await factory.joinMatch(match, bob);

    const alicePage = await asUser(alice.email);
    await alicePage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await alicePage
      .getByRole('listitem')
      .filter({ hasText: `${bob.firstName} ${bob.lastName}` })
      .first()
      .getByRole('button', { name: 'Block', exact: true })
      .click();
    await expect(alicePage.getByRole('button', { name: 'Unblock' })).toBeVisible();

    // A block is SYMMETRIC, so Alice's name is masked for Bob as well — neither
    // sees the other. That is deliberate: a one-way block would leave the
    // person who blocked still reachable by the person they blocked.
    //
    // What Bob must NOT learn is that HE was blocked, or by whom. The masked
    // row is indistinguishable from any other blocked relationship, and his own
    // block list stays empty — so nothing tells him he is the subject rather
    // than a party. Being told would be an invitation to make a second account.
    const bobPage = await asUser(bob.email);
    await bobPage.goto(`/leagues/${league.slug}/matches/${match.id}`);

    // He still sees a full roster; he simply cannot tell who that row is.
    await expect(bobPage.getByRole('heading', { name: /Confirmed roster/i })).toBeVisible();
    await expect(bobPage.getByText(`${alice.firstName} ${alice.lastName}`)).toHaveCount(0);

    // Nothing anywhere names Alice, or says he was blocked.
    const content = await bobPage.content();
    expect(content).not.toContain(alice.firstName);
    expect(content).not.toMatch(/blocked you|has blocked/i);

    await bobPage.goto('/settings/blocked');
    await expect(bobPage.getByText(/have not blocked anyone/i)).toBeVisible();
  });

  test('the content filter refuses objectionable text in a real form', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const page = await asUser(league.admin.email);

    await page.goto(`/leagues/${league.slug}/settings`);
    await expectNoServerError(page);

    const description = page.getByLabel(/Description/i).first();
    await description.fill('fuck this league');
    await page.getByRole('button', { name: /Save/i }).first().click();

    // A generic message: it names the rule, never the text.
    await expect(page.getByText(/not allowed here/i)).toBeVisible();
  });
});

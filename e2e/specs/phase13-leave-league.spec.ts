import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, expectNoServerError, test } from '../support/fixtures';
import type { TestDataFactory, TestLeague, TestUser } from '../support/factory';

/**
 * Leaving a league, driven the way somebody actually does it.
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────
 *
 * Every other way a membership ended belonged to somebody else — an
 * administrator removing you, or a suspension. A player who was finished with a
 * league had to email an organizer and ask, which is the shape of problem this
 * product exists to remove. The self-service rehearsal found it immediately.
 *
 * ── WHY THESE ASSERTIONS AND NOT OTHERS ────────────────────────────────────
 *
 * The database suite already proves the cascade, the refusals and the audit
 * trail. What only a browser can prove is the part in between: that the control
 * is where somebody would look for it, that it takes two deliberate taps, that
 * cancelling really does nothing, and that the app the player is left holding
 * afterwards is coherent — the right league active, the old one refused, no
 * stale badge and no redirect loop.
 */

const PHONE = { width: 390, height: 844 };

test.use({ viewport: PHONE });

function strip(page: Page) {
  return page.getByRole('button', { name: /^Active league:/ });
}

/** The menu and the confirmation are both dialogs, so both are named. */
function menu(page: Page) {
  return page.getByRole('dialog', { name: 'Your leagues' });
}

function confirmation(page: Page) {
  return page.getByRole('dialog', { name: /^Leave / });
}

/**
 * Opens the menu, tolerating the hydration window.
 *
 * `networkidle` says the requests have stopped, not that React has attached its
 * listeners — a press that lands in the gap does nothing at all. Retrying the
 * interaction rather than sleeping keeps this honest: it still fails if the
 * control genuinely never opens.
 */
async function openMenu(page: Page) {
  await page.waitForLoadState('networkidle');
  await expect(async () => {
    await strip(page).click();
    await expect(menu(page)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

async function openDashboardMenu(page: Page) {
  await page.goto('/dashboard');
  await openMenu(page);
}

/**
 * Confirms the departure and waits for it to have actually landed.
 *
 * Deliberately NOT `waitForURL('/dashboard')`. The menu opens from the app
 * shell, so the sheet is usually opened *on* the dashboard — the URL the action
 * redirects to is the URL the page is already showing, and the wait resolves
 * instantly on the pre-submit page. Two assertions read stale rows because of
 * exactly that. The notice only exists after the redirect, so waiting for it
 * waits for the thing that happened rather than for a URL that never changed.
 */
async function confirmLeave(page: Page) {
  await confirmation(page).getByRole('button', { name: 'Leave league' }).click();
  await expect(page.locator('body')).toContainText('You have left that league');
}

/** Somebody who plays in two leagues, with the first one pinned as active. */
async function twoLeaguePlayer(
  factory: TestDataFactory,
): Promise<{ player: TestUser; a: TestLeague; b: TestLeague }> {
  const a = await factory.createLeague({ visibility: 'searchable' });
  const b = await factory.createLeague();

  const player = await factory.createMember(a);
  await factory.query(
    `insert into public.league_memberships (league_id, user_id, role, status)
     values ($1, $2, 'player', 'active')`,
    [b.id, player.id],
  );

  // Pinned, because otherwise this is a coin toss: with no stored preference the
  // app falls back to the first active membership *by league name*, and the
  // factory's names end in a random token.
  await factory.query(
    `insert into public.user_app_state (user_id, active_league_id) values ($1, $2)
       on conflict (user_id) do update set active_league_id = excluded.active_league_id`,
    [player.id, a.id],
  );

  return { player, a, b };
}

async function membershipOf(factory: TestDataFactory, leagueId: string, userId: string) {
  const rows = await factory.query<{ id: string; status: string }>(
    'select id, status::text from public.league_memberships where league_id = $1 and user_id = $2',
    [leagueId, userId],
  );
  return rows[0] ?? null;
}

// ══════════════════════════════════════════════════════════════════════════
// The primary flow.
// ══════════════════════════════════════════════════════════════════════════

test.describe('a player leaving one of their leagues', () => {
  test('confirms, leaves, falls back to the other league, and can come back', async ({
    factory,
    asUser,
  }) => {
    const { player, a, b } = await twoLeaguePlayer(factory);

    // A match they are in, and a match already played, so leaving has both
    // something to release and something it must not touch.
    const upcoming = await factory.createMatch(a, { kickoffInHours: 72 });
    await factory.joinMatch(upcoming, player);
    const played = await factory.createMatch(a, { kickoffInHours: 48 });
    await factory.joinMatch(played, player);
    await factory.endMatch(played, 3);

    const membershipBefore = (await membershipOf(factory, a.id, player.id))!;

    const page = await asUser(player.email);
    await openDashboardMenu(page);
    await expect(strip(page)).toContainText(a.name);

    // ── The control ───────────────────────────────────────────────────────
    const leave = menu(page).getByRole('button', { name: 'Leave league' });
    await expect(leave).toBeVisible();
    await leave.click();

    // ── The confirmation ──────────────────────────────────────────────────
    const confirm = confirmation(page);
    await expect(confirm).toBeVisible();
    // It names the league, because "Leave this league?" over a sheet that has
    // just covered the list is a question somebody cannot check.
    await expect(confirm.getByRole('heading', { name: `Leave ${a.name}?` })).toBeVisible();
    // And it says what is kept, because the fear at this moment is that you are
    // deleting your own record of having played.
    await expect(confirm).toContainText('will not be deleted');

    // ── Cancel changes nothing ────────────────────────────────────────────
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    // Back in the menu you were standing in, not dumped on the page.
    await expect(menu(page)).toBeVisible();
    expect((await membershipOf(factory, a.id, player.id))!.status).toBe('active');

    // ── Two deliberate taps, again, and this time confirmed ───────────────
    await menu(page).getByRole('button', { name: 'Leave league' }).click();
    await expect(confirmation(page)).toBeVisible();
    await confirmation(page).getByRole('button', { name: 'Leave league' }).click();

    // ── What the player is left holding ───────────────────────────────────
    await page.waitForURL(/\/dashboard/);
    await expect(page.locator('body')).toContainText('You have left that league');
    await expectNoServerError(page);

    // League B is the active league now, chosen by the ordinary fallback rather
    // than by anything this feature wrote.
    await expect(strip(page)).toContainText(b.name);
    await expect(strip(page)).not.toContainText(a.name);

    // League A is gone from the menu's active memberships.
    await openMenu(page);
    await expect(menu(page).getByRole('button', { name: new RegExp(a.name) })).toHaveCount(0);
    await expect(menu(page).getByText(a.name)).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Member-only pages of the league they left now refuse them, cleanly.
    await page.goto(`/leagues/${a.slug}/matches`);
    await page.waitForURL(/\/dashboard/);
    await expectNoServerError(page);

    // ── The history that must survive ─────────────────────────────────────
    const history = await factory.query<{ n: string }>(
      `select count(*)::text as n from public.match_signups where membership_id = $1`,
      [membershipBefore.id],
    );
    expect(Number(history[0]!.n)).toBe(2);

    // ── The administrator hears about it ──────────────────────────────────
    const adminPage = await asUser(a.admin.email);
    await adminPage.goto('/notifications');
    await expect(adminPage.getByText('A member left')).toBeVisible();
    await expect(adminPage.getByText(`left ${a.name}.`)).toBeVisible();

    // ── And they can come back ────────────────────────────────────────────
    await page.goto('/leagues/discover');
    await page.getByLabel('Search by name or area').fill(a.name);
    await page.getByRole('button', { name: 'Search' }).click();
    // Nothing marks a departed member as barred. Leaving is not a sanction.
    await page.getByRole('button', { name: 'Request to join' }).click();
    await page.getByRole('button', { name: 'Send request' }).click();
    await expect(page.getByText('Request sent — awaiting approval.')).toBeVisible();

    await adminPage.goto(`/leagues/${a.slug}/members`);
    await adminPage.getByRole('button', { name: 'Approve' }).first().click();
    await expect(adminPage.getByRole('button', { name: 'Approve' })).toHaveCount(0);

    const membershipAfter = (await membershipOf(factory, a.id, player.id))!;
    // The same row, revived — which is what makes every historical record
    // reattach with no backfill and no copying.
    expect(membershipAfter.id).toBe(membershipBefore.id);
    expect(membershipAfter.status).toBe('active');
  });

  test('releases the place they were holding in a future match', async ({ factory, asUser }) => {
    const { player, a } = await twoLeaguePlayer(factory);
    const match = await factory.createMatch(a, { kickoffInHours: 72, capacity: 4 });
    await factory.joinMatch(match, player);

    const page = await asUser(player.email);
    await openDashboardMenu(page);
    await menu(page).getByRole('button', { name: 'Leave league' }).click();
    await confirmLeave(page);

    const rows = await factory.query<{ status: string }>(
      `select s.status::text from public.match_signups s
         join public.league_memberships m on m.id = s.membership_id
        where s.match_id = $1 and m.user_id = $2`,
      [match.id, player.id],
    );
    // Not deleted, and not a cancellation by the player: `not_selected` is what
    // every other involuntary withdrawal in the product writes.
    expect(rows[0]!.status).toBe('not_selected');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The only-league case.
// ══════════════════════════════════════════════════════════════════════════

test.describe('a player leaving their only league', () => {
  test('lands on the no-active-league dashboard with somewhere to go', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    const page = await asUser(player.email);
    await openDashboardMenu(page);
    await menu(page).getByRole('button', { name: 'Leave league' }).click();
    await confirmLeave(page);
    await expectNoServerError(page);

    // The strip is gone, because there is nothing for it to name.
    await expect(strip(page)).toHaveCount(0);
    // And the dashboard is the ordinary empty state rather than a broken page:
    // the two things somebody in this position can actually do.
    await expect(page.getByRole('link', { name: /Find a league/i }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Create a league/i }).first()).toBeVisible();

    // No stale badge and no menu left behind.
    await expect(menu(page)).toHaveCount(0);
    await expect(confirmation(page)).toHaveCount(0);

    // No redirect loop: a reload settles, and so does a second visit.
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard/);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
    await expectNoServerError(page);

    // The league itself is untouched — leaving is not deleting.
    const leagues = await factory.query<{ n: string }>(
      'select count(*)::text as n from public.leagues where id = $1',
      [league.id],
    );
    expect(leagues[0]!.n).toBe('1');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The administrator.
// ══════════════════════════════════════════════════════════════════════════

test.describe('the league administrator', () => {
  test('is told to transfer first, and may leave once they have', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const successor = await factory.createMember(league);

    const page = await asUser(league.admin.email);
    await openDashboardMenu(page);

    // No enabled destructive action anywhere in the sheet.
    await expect(menu(page).getByRole('button', { name: 'Leave league' })).toHaveCount(0);

    // What is there instead says what to do about it, and goes there.
    const explanation = menu(page).getByRole('link', {
      name: /Transfer administration before leaving/,
    });
    await expect(explanation).toBeVisible();
    await explanation.click();
    await expect(page).toHaveURL(new RegExp(`/leagues/${league.slug}/members`));

    // ── Transfer, then leave ──────────────────────────────────────────────
    await page.getByLabel('New administrator').selectOption(successor.membershipId);
    await page.getByLabel('Type “transfer” to confirm').fill('transfer');
    await page.getByRole('button', { name: /transfer administration/i }).click();
    await page.waitForURL(/\/dashboard/);

    await openMenu(page);
    // Now an ordinary player, so the control is offered.
    await expect(menu(page).getByRole('link', { name: /Transfer administration/ })).toHaveCount(0);
    await menu(page).getByRole('button', { name: 'Leave league' }).click();
    await confirmLeave(page);
    await expectNoServerError(page);
    await expect(strip(page)).toHaveCount(0);

    // The league still has exactly one active administrator — the successor.
    const admins = await factory.query<{ user_id: string }>(
      `select user_id from public.league_memberships
        where league_id = $1 and role = 'league_admin' and status = 'active'`,
      [league.id],
    );
    expect(admins).toHaveLength(1);
    expect(admins[0]!.user_id).toBe(successor.id);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// A suspended member.
// ══════════════════════════════════════════════════════════════════════════

test.describe('a suspended member', () => {
  test('can still leave, from the row that names their suspension', async ({ factory, asUser }) => {
    const active = await factory.createLeague();
    const other = await factory.createLeague();
    const player = await factory.createMember(active);
    await factory.query(
      `insert into public.league_memberships (league_id, user_id, role, status, status_reason)
       values ($1, $2, 'player', 'suspended', 'Cooling-off period')`,
      [other.id, player.id],
    );
    await factory.query(
      `insert into public.user_app_state (user_id, active_league_id) values ($1, $2)
         on conflict (user_id) do update set active_league_id = excluded.active_league_id`,
      [player.id, active.id],
    );

    const page = await asUser(player.email);
    await openDashboardMenu(page);

    // A suspended membership cannot be switched to, so it can never become the
    // "current league" the footer control acts on. Its own row carries the way
    // out — a suspension stops somebody playing, and must not also trap them.
    const suspendedRow = menu(page).locator('li', { hasText: other.name });
    await expect(suspendedRow.getByText('Suspended')).toBeVisible();
    await suspendedRow.getByRole('button', { name: 'Leave' }).click();

    await expect(confirmation(page).getByRole('heading', { name: `Leave ${other.name}?` })).toBeVisible();
    await confirmLeave(page);
    await expectNoServerError(page);

    expect((await membershipOf(factory, other.id, player.id))!.status).toBe('removed');
    // The league they were actually in is untouched.
    expect((await membershipOf(factory, active.id, player.id))!.status).toBe('active');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Mobile and accessibility.
// ══════════════════════════════════════════════════════════════════════════

test.describe('the confirmation on a phone', () => {
  async function openConfirmation(page: Page) {
    await openDashboardMenu(page);
    await menu(page).getByRole('button', { name: 'Leave league' }).click();
    await expect(confirmation(page)).toBeVisible();
  }

  async function expectNoHorizontalScroll(page: Page, label: string) {
    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow, `${label} scrolls the page sideways`).toBeLessThanOrEqual(1);
  }

  test('fits 320px, keeps both buttons a fingertip tall, and passes axe', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    const page = await asUser(player.email);
    await page.setViewportSize({ width: 320, height: 568 });
    await openConfirmation(page);

    await expectNoHorizontalScroll(page, 'the leave confirmation at 320px');

    for (const name of ['Cancel', 'Leave league']) {
      const box = await confirmation(page).getByRole('button', { name }).boundingBox();
      expect(box?.height ?? 0, `"${name}" is under 44px tall`).toBeGreaterThanOrEqual(44);
    }

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(
      results.violations.map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.map((node) => node.target.join(' ')),
      })),
    ).toEqual([]);
  });

  test('holds up in dark mode and with a very long league name', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const player = await factory.createMember(league);
    await factory.query('update public.leagues set name = $2 where id = $1', [
      league.id,
      'Thursday Night Five-a-Side and Occasional Seven-a-Side Football Club',
    ]);

    const page = await asUser(player.email);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 320, height: 568 });
    await openConfirmation(page);

    await expectNoHorizontalScroll(page, 'a long league name at 320px in dark mode');

    const results = await new AxeBuilder({ page }).withTags(['wcag2aa']).analyze();
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  test('cannot be triggered by one tap, and Escape backs out of it', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    const page = await asUser(player.email);
    await openConfirmation(page);

    // Escape dismisses the confirmation only — the menu underneath is still
    // there, which is what makes cancelling cheap.
    await page.keyboard.press('Escape');
    await expect(confirmation(page)).toBeHidden();
    await expect(menu(page)).toBeVisible();

    // One tap on the row has now happened twice and nothing has been left.
    expect((await membershipOf(factory, league.id, player.id))!.status).toBe('active');

    // A click on the confirmation's backdrop backs out too, and does not take
    // the menu with it — the two dialogs are siblings for exactly this reason.
    await menu(page).getByRole('button', { name: 'Leave league' }).click();
    await expect(confirmation(page)).toBeVisible();
    await page.mouse.click(8, 8);
    await expect(confirmation(page)).toBeHidden();
    await expect(menu(page)).toBeVisible();

    expect((await membershipOf(factory, league.id, player.id))!.status).toBe('active');
  });

  test('reopening after Escape still works, repeatedly', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    const page = await asUser(player.email);
    await openDashboardMenu(page);

    // The `<dialog>` reopen race, which cost this menu three or four failures
    // in every twenty cycles before the stale-`close` guard went in. The
    // confirmation is a second dialog and inherits the same hazard.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await menu(page).getByRole('button', { name: 'Leave league' }).click();
      await expect(confirmation(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(confirmation(page)).toBeHidden();
    }

    await expect(menu(page)).toBeVisible();
    expect((await membershipOf(factory, league.id, player.id))!.status).toBe('active');
  });
});

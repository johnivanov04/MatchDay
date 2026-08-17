import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, expectNoServerError, test } from '../support/fixtures';
import type { TestDataFactory, TestLeague, TestUser } from '../support/factory';

/**
 * The league menu behind the active-league strip.
 *
 * ── WHAT REGRESSED, AND WHY IT NEEDED ITS OWN SPEC ─────────────────────────
 *
 * The strip was a `<Link href="/dashboard">` wearing a chevron and a hover
 * state: on the dashboard — the screen it is most visible on — tapping it
 * navigated to the page you were already on. Nothing failed, nothing errored,
 * and no assertion anywhere noticed, because "a link that goes where you
 * already are" is indistinguishable from a working link to every check the
 * suite had. So the assertions here are about the *interaction*: that opening
 * it produces something, and that the something can actually switch a league.
 *
 * Every test drives the real control at a phone width. The menu is a native
 * `<dialog>` opened with `showModal()`, so Escape, the focus trap and the
 * backdrop are the platform's rather than ours — but they are still asserted,
 * because "we used the platform" is a claim about behaviour like any other.
 */

const PHONE = { width: 390, height: 844 };

test.use({ viewport: PHONE });

/** The strip itself: one control, named for the league it is showing. */
function strip(page: Page) {
  return page.getByRole('button', { name: /^Active league:/ });
}

function menu(page: Page) {
  return page.getByRole('dialog');
}

/**
 * Opens the menu, tolerating the hydration window.
 *
 * `networkidle` says the requests have stopped, not that React has attached its
 * listeners — and a press that lands in the gap does nothing at all. Retrying
 * the *interaction* rather than sleeping keeps the assertion honest: this still
 * fails if the control genuinely does not open, which is the exact defect this
 * spec exists for. Re-opening an already-open sheet is a no-op, so a late first
 * press costs nothing.
 */
async function open(page: Page, press: () => Promise<void>) {
  await expect(async () => {
    await press();
    await expect(menu(page)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

async function openMenu(page: Page) {
  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle');
  await open(page, () => strip(page).click());
}

/**
 * Somebody who administers one league and plays in another.
 *
 * Two leagues is the minimum that makes switching observable, and the
 * administrator/player split is what makes "Manage league" a decision rather
 * than a constant.
 */
async function twoLeagueAdmin(
  factory: TestDataFactory,
): Promise<{ user: TestUser; owned: TestLeague; joined: TestLeague }> {
  const owned = await factory.createLeague();
  const joined = await factory.createLeague();

  // A league may only have one active administrator, so the second membership
  // is an ordinary one — which is also the realistic shape.
  await factory.query(
    `insert into public.league_memberships (league_id, user_id, role, status)
     values ($1, $2, 'player', 'active')`,
    [joined.id, owned.admin.id],
  );

  // Pinning the active league, because otherwise these tests are a coin toss.
  // With no stored preference the app falls back to the first active membership
  // *by league name*, and the factory's names end in a random token — so which
  // of the two is "current" and which is the switchable row would be decided by
  // an alphabetical accident on every run.
  await factory.query(
    `insert into public.user_app_state (user_id, active_league_id) values ($1, $2)
       on conflict (user_id) do update set active_league_id = excluded.active_league_id`,
    [owned.admin.id, owned.id],
  );

  return { user: owned.admin, owned, joined };
}

async function storedActiveLeague(
  factory: TestDataFactory,
  userId: string,
): Promise<string | null | undefined> {
  const rows = await factory.query<{ active: string | null }>(
    'select active_league_id as active from public.user_app_state where user_id = $1',
    [userId],
  );
  return rows[0]?.active;
}

test.describe('the active-league strip', () => {
  test('opens a menu naming the current league and every other membership', async ({
    factory,
    asUser,
  }) => {
    const { user, owned, joined } = await twoLeagueAdmin(factory);
    // A third league they have asked to join but are not in yet.
    const wanted = await factory.createLeague();
    await factory.query(
      `insert into public.league_memberships (league_id, user_id, role, status)
       values ($1, $2, 'player', 'pending')`,
      [wanted.id, user.id],
    );

    const page = await asUser(user.email);
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    // The dashboard's own switcher is gone, and so is its copy of the pending
    // membership. With an active league, the strip is forty pixels above where
    // that block used to be and its menu carries both — which is the whole
    // point of moving them.
    await expect(page.getByRole('combobox', { name: 'Active league' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Switch' })).toHaveCount(0);
    await expect(page.getByText('Awaiting approval', { exact: true })).toHaveCount(0);

    await open(page, () => strip(page).click());

    // The current league is named and marked as current, rather than merely
    // being one of three rows the reader has to work out.
    const dialog = menu(page);
    await expect(dialog.getByText(owned.name)).toBeVisible();
    await expect(dialog.getByText('Current league')).toBeVisible();
    await expect(dialog.getByRole('button', { name: new RegExp(joined.name) })).toBeVisible();

    // A membership that is still pending is shown, and is not a control: the
    // person can see they asked without the app implying they can act there.
    await expect(dialog.getByText(wanted.name)).toBeVisible();
    await expect(dialog.getByText('Awaiting approval', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: new RegExp(wanted.name) })).toHaveCount(0);
  });

  test('switching a league writes the choice and updates the active context', async ({
    factory,
    asUser,
  }) => {
    const { user, owned, joined } = await twoLeagueAdmin(factory);

    const page = await asUser(user.email);
    await openMenu(page);
    await menu(page).getByRole('button', { name: new RegExp(joined.name) }).click();

    // The persisted row is the assertion, not the rendered strip: this is the
    // same server action the dashboard control used, and what makes a switch
    // real is that it survives the session.
    await expect.poll(() => storedActiveLeague(factory, user.id)).toBe(joined.id);

    // The menu gets out of the way once it has done its job, and the strip
    // behind it is showing the league that was just chosen.
    await expect(menu(page)).toBeHidden();
    await expect(strip(page)).toContainText(joined.name);
    await expect(strip(page)).not.toContainText(owned.name);

    // And the choice survives a reload, because it lives in `user_app_state`
    // rather than in this tab.
    await page.reload();
    await expect(strip(page)).toContainText(joined.name);
    await expectNoServerError(page);
  });

  test('the switched-to league is the one the rest of the app then works in', async ({
    factory,
    asUser,
  }) => {
    const { user, joined } = await twoLeagueAdmin(factory);
    // A match in the league they are about to switch to, so "active context"
    // means something more than a caption.
    await factory.createMatch(joined, { kickoffInHours: 72 });

    const page = await asUser(user.email);
    await openMenu(page);
    await menu(page).getByRole('button', { name: new RegExp(joined.name) }).click();
    await expect.poll(() => storedActiveLeague(factory, user.id)).toBe(joined.id);

    // The Matches tab points at the active league. After switching it must
    // point at the new one — this is the whole reason switching exists.
    await page.getByRole('link', { name: 'Matches' }).click();
    await expect(page).toHaveURL(new RegExp(`/leagues/${joined.slug}/matches`));
  });

  test('an administrator is offered Manage league and a player is not', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    const adminPage = await asUser(league.admin.email);
    await openMenu(adminPage);
    await expect(menu(adminPage).getByRole('link', { name: 'Manage league' })).toBeVisible();

    const playerPage = await asUser(player.email);
    await openMenu(playerPage);
    await expect(menu(playerPage).getByRole('link', { name: 'Manage league' })).toHaveCount(0);
  });

  test('Manage league opens the league it names', async ({ factory, asUser }) => {
    const league = await factory.createLeague();

    const page = await asUser(league.admin.email);
    await openMenu(page);
    await menu(page).getByRole('link', { name: 'Manage league' }).click();

    await expect(page).toHaveURL(new RegExp(`/leagues/${league.slug}/settings`));
    await expect(page.getByRole('heading', { name: 'League settings' })).toBeVisible();
    // Navigating away takes the sheet with it.
    await expect(menu(page)).toHaveCount(0);
  });

  test('Find a league and Create a league go where they say', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    const page = await asUser(player.email);

    await openMenu(page);
    await menu(page).getByRole('link', { name: 'Find a league' }).click();
    await expect(page).toHaveURL(/\/leagues\/discover/);

    await openMenu(page);
    await menu(page).getByRole('link', { name: 'Create a league' }).click();
    await expect(page).toHaveURL(/\/leagues\/new/);
    await expect(page.getByRole('heading', { name: 'Create a league' })).toBeVisible();
  });

  test('somebody in exactly one league still gets a menu worth opening', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    const page = await asUser(player.email);
    await openMenu(page);

    // The point of the requirement: no dead tap. There is nothing to switch to,
    // so what the menu owes them is where they are and where they can go next.
    const dialog = menu(page);
    await expect(dialog.getByText(league.name)).toBeVisible();
    await expect(dialog.getByText('Current league')).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Find a league' })).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Create a league' })).toBeVisible();
  });

  test('opens with the keyboard, closes with Escape, and gives focus back', async ({
    factory,
    asUser,
  }) => {
    const { user, joined } = await twoLeagueAdmin(factory);

    const page = await asUser(user.email);
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    await open(page, async () => {
      await strip(page).focus();
      await page.keyboard.press('Enter');
    });

    // `showModal()` puts focus inside the dialog rather than leaving it on the
    // control behind it — the difference between a modal and a decoration.
    await expect(strip(page)).not.toBeFocused();
    await expect(menu(page).getByRole('button', { name: new RegExp(joined.name) })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    // Focus comes back to where it was, so a keyboard user is not returned to
    // the top of the document for having looked at a menu.
    await expect(strip(page)).toBeFocused();

    // And it can be opened again afterwards — a dialog that closes once and
    // then refuses to reopen is the classic `showModal()` state bug.
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
  });

  test('a click on the backdrop closes it', async ({ factory, asUser }) => {
    const league = await factory.createLeague();

    const page = await asUser(league.admin.email);
    await openMenu(page);

    // The top-left corner of the viewport is backdrop at every width: the sheet
    // is pinned to the bottom edge on a phone.
    await page.mouse.click(8, 8);
    await expect(menu(page)).toBeHidden();
    await expect(strip(page)).toBeFocused();
  });

  test('fits a 320px phone and passes the accessibility pass while open', async ({
    factory,
    asUser,
  }) => {
    const { user } = await twoLeagueAdmin(factory);

    const page = await asUser(user.email);
    await page.setViewportSize({ width: 320, height: 568 });
    await openMenu(page);

    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow, 'the league menu scrolls the page sideways at 320px').toBeLessThanOrEqual(1);

    // Every control in the sheet is a fingertip tall.
    const small = await page.evaluate(() => {
      const results: string[] = [];
      for (const control of document.querySelectorAll<HTMLElement>('dialog button, dialog a')) {
        const rect = control.getBoundingClientRect();
        if (rect.height > 0 && rect.height < 44) {
          results.push(`${control.tagName.toLowerCase()} "${control.textContent ?? ''}"`);
        }
      }
      return results;
    });
    expect(small, 'the league menu has controls under 44px tall').toEqual([]);

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
});

/**
 * The other half of removing the dashboard's switcher: what happens to somebody
 * who has memberships but no *active* one.
 *
 * The strip only renders when there is an active league, so for this person
 * there is no menu to open — and the pending membership they are waiting on has
 * to be visible on the page itself or it is visible nowhere at all.
 */
test('a dashboard with no active league still names the memberships that exist', async ({
  factory,
  asUser,
}) => {
  const league = await factory.createLeague();
  const waiting = await factory.createOutsider();
  await factory.query(
    `insert into public.league_memberships (league_id, user_id, role, status)
     values ($1, $2, 'player', 'pending')`,
    [league.id, waiting.id],
  );

  const page = await asUser(waiting.email);
  await page.goto('/dashboard');

  await expect(strip(page)).toHaveCount(0);
  await expect(page.getByText(league.name)).toBeVisible();
  // Exact, because the empty state above it also says "awaiting approval" in a
  // sentence; the badge is the assertion.
  await expect(page.getByText('Awaiting approval', { exact: true })).toBeVisible();
  await expectNoServerError(page);
});

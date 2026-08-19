import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';

/**
 * The league forms after gaining a Match timing group.
 *
 * Create League grew from four steps to five and League Settings gained four
 * number inputs. Both are long forms on a small screen, and a long form is
 * where horizontal overflow and unreachable submit buttons come from — so the
 * whole thing is measured at 320px rather than eyeballed.
 */

const PHONE = { width: 320, height: 568 };

test.use({ viewport: PHONE });

async function expectNoHorizontalScroll(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const limit = root.clientWidth;
    const culprits: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>('*')) {
      const rect = element.getBoundingClientRect();
      if (rect.right > limit + 1) {
        culprits.push(
          `<${element.tagName.toLowerCase()}> right=${String(Math.round(rect.right))} "${(
            element.textContent ?? ''
          )
            .trim()
            .slice(0, 40)}"`,
        );
      }
    }
    return { scrollWidth: root.scrollWidth, clientWidth: limit, culprits: culprits.slice(0, 5) };
  });

  expect(
    overflow.scrollWidth - overflow.clientWidth,
    `${label} scrolls sideways at 320px. Widest: ${overflow.culprits.join(' | ') || '(none)'}`,
  ).toBeLessThanOrEqual(1);
}

/**
 * Every control is a fingertip tall — measuring what a finger actually hits.
 *
 * A checkbox is 20px by design and always will be; what somebody taps is the
 * `<label>` wrapping it, which carries `min-h-control` and comes out at 46px.
 * Measuring the `<input>` alone would report the two league-preference
 * checkboxes as failures and be wrong about the thing that matters. So a
 * control nested in a label inherits that label's height, and anything not so
 * wrapped is measured on its own.
 */
async function expectTouchTargets(page: Page, label: string): Promise<void> {
  const small = await page.evaluate(() => {
    const results: string[] = [];
    for (const control of document.querySelectorAll<HTMLElement>(
      'button, select, input:not([type="hidden"]), textarea',
    )) {
      const rect = control.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const wrapper = control.closest('label');
      const effective = Math.max(rect.height, wrapper?.getBoundingClientRect().height ?? 0);

      if (effective < 44) {
        results.push(
          `${control.tagName.toLowerCase()}#${control.id || '(no id)'} = ${String(Math.round(effective))}px`,
        );
      }
    }
    return results;
  });

  expect(small, `${label} has controls under 44px tall`).toEqual([]);
}

async function axeClean(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => node.target.join(' ')),
    })),
    `${label} has WCAG AA violations`,
  ).toEqual([]);
}

test.describe('the league forms at 320px', () => {
  test('Create League, with its new Match timing step', async ({ factory, asUser }) => {
    const organizer = await factory.createOutsider();
    const page = await asUser(organizer.email);

    await page.goto('/leagues/new');
    await expect(page.getByRole('heading', { name: 'Create a league' })).toBeVisible();
    await page.waitForLoadState('networkidle');

    // The new group is present and numbered into the guided sequence.
    await expect(page.getByText('Match timing')).toBeVisible();
    await expect(page.getByText('Review')).toBeVisible();

    await expectNoHorizontalScroll(page, 'Create League');
    await expectTouchTargets(page, 'Create League');
    await axeClean(page, 'Create League');

    // The unit is stated once per group rather than repeated in four labels,
    // so a 320px column does not have to carry "hours before kickoff" ×4.
    await expect(page.getByText(/in hours before kickoff/i)).toBeVisible();

    // Optional fields say so.
    const optional = page.locator('label', { hasText: 'Priority window' });
    await expect(optional).toContainText('Optional');
  });

  test('League Settings, with the same group', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const page = await asUser(league.admin.email);

    await page.goto(`/leagues/${league.slug}/settings`);
    await expect(page.getByRole('heading', { name: 'League settings' })).toBeVisible();
    await page.waitForLoadState('networkidle');

    await expect(page.getByText('Match timing')).toBeVisible();
    // The sentence that stops an organizer fearing they have moved a match
    // they already published.
    await expect(
      page.getByText(/does not change matches that have already been created/i),
    ).toBeVisible();

    await expectNoHorizontalScroll(page, 'League Settings');
    await expectTouchTargets(page, 'League Settings');
    await axeClean(page, 'League Settings');
  });

  test('the Save control stays reachable with the keyboard open', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const page = await asUser(league.admin.email);

    await page.goto(`/leagues/${league.slug}/settings`);
    await page.waitForLoadState('networkidle');

    // Focusing the last timing field is what a phone keyboard would do; the
    // submit must still be scrollable into view rather than trapped behind the
    // fixed tab bar.
    await page.getByLabel('Roster publish target').focus();
    const save = page.getByRole('button', { name: 'Save settings' });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeVisible();

    const box = await save.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test('both forms hold up in dark mode', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const page = await asUser(league.admin.email);
    await page.emulateMedia({ colorScheme: 'dark' });

    for (const path of ['/leagues/new', `/leagues/${league.slug}/settings`]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expectNoHorizontalScroll(page, `${path} in dark mode`);

      const results = await new AxeBuilder({ page }).withTags(['wcag2aa']).analyze();
      expect(
        results.violations.map((violation) => violation.id),
        `${path} has contrast or other WCAG AA violations in dark mode`,
      ).toEqual([]);
    }
  });

  test('a long league name does not break the settings form', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const page = await asUser(league.admin.email);

    await page.goto(`/leagues/${league.slug}/settings`);
    await page.waitForLoadState('networkidle');
    await page
      .getByLabel('League name')
      .fill('Thursday Night Five-a-Side and Occasional Seven-a-Side Football Club');

    await expectNoHorizontalScroll(page, 'League Settings with a long name');
  });
});

test.describe('the league forms at 390px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Create League and Settings are usable on an ordinary phone', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const page = await asUser(league.admin.email);

    for (const path of ['/leagues/new', `/leagues/${league.slug}/settings`]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expectNoHorizontalScroll(page, `${path} at 390px`);
      await expectTouchTargets(page, `${path} at 390px`);
    }
  });
});

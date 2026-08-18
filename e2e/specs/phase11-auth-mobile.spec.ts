import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';

/**
 * The authentication screens on a phone.
 *
 * These are the most critical phone surfaces in the product: everybody meets
 * them, most people meet them exactly once, and a form somebody cannot complete
 * on a 320px screen is not a rough edge — it is a member who never joins.
 *
 * The whole set runs at 320×568, the narrowest viewport still worth supporting,
 * because a layout that survives 320 survives everything above it.
 */

const PHONE = { width: 320, height: 568 };

test.use({ viewport: PHONE });

const SCREENS: { path: string; heading: string }[] = [
  { path: '/sign-in', heading: 'Sign in' },
  { path: '/sign-up', heading: 'Create account' },
  { path: '/forgot-password', heading: 'Forgot or don’t have a password?' },
];

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

async function expectTouchTargets(page: Page, label: string): Promise<void> {
  const small = await page.evaluate(() => {
    const results: string[] = [];
    for (const control of document.querySelectorAll<HTMLElement>(
      'button, select, input:not([type="hidden"]), textarea',
    )) {
      const rect = control.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.height < 44) {
        results.push(`${control.tagName.toLowerCase()}#${control.id || '(no id)'} = ${String(Math.round(rect.height))}px`);
      }
    }
    return results;
  });

  expect(small, `${label} has controls under 44px tall`).toEqual([]);
}

test.describe('the authentication screens at 320px', () => {
  for (const { path, heading } of SCREENS) {
    test(`${path} fits, is operable and passes axe`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await page.waitForLoadState('networkidle');

      await expectNoHorizontalScroll(page, path);
      await expectTouchTargets(page, path);

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

    test(`${path} survives a long error message`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');

      // A wrong-looking submission on each screen, so the error state is what
      // is being measured rather than the pristine one. An error that pushes
      // the layout sideways is the classic mobile form bug.
      await page.getByLabel('Email address').fill('not-an-email');
      const submit = page.getByRole('button', { name: /Sign in$|Create account|Send recovery/ }).first();
      await submit.click();
      await page.waitForTimeout(500);

      await expectNoHorizontalScroll(page, `${path} with an error`);
    });
  }

  test('the password field can be revealed, and the toggle is a real target', async ({ page }) => {
    await page.goto('/sign-in');
    await page.waitForLoadState('networkidle');

    const password = page.getByLabel('Password', { exact: true });
    await password.fill('a passphrase worth checking');

    // Masked to begin with — the default must never be "showing".
    await expect(password).toHaveAttribute('type', 'password');

    const toggle = page.getByRole('button', { name: 'Show password' });
    const box = await toggle.boundingBox();
    expect(box?.height ?? 0, 'the show/hide control is under 44px tall').toBeGreaterThanOrEqual(44);

    await toggle.click();
    await expect(password).toHaveAttribute('type', 'text');
    // The state, not the action, is what assistive technology needs.
    await expect(page.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.getByRole('button', { name: 'Hide password' }).click();
    await expect(password).toHaveAttribute('type', 'password');
  });

  test('the fields carry the attributes a password manager needs', async ({ page }) => {
    await page.goto('/sign-in');
    await page.waitForLoadState('networkidle');

    // `username` + `current-password` is the pair that makes a manager offer to
    // fill, and to save the two together afterwards.
    await expect(page.getByLabel('Email address')).toHaveAttribute('autocomplete', 'username');
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute(
      'autocomplete',
      'current-password',
    );

    await page.goto('/sign-up');
    await page.waitForLoadState('networkidle');
    // `new-password` on both, so a manager offers to *generate* rather than
    // filling the old one into the confirmation box.
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
    await expect(page.getByLabel('Confirm password')).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
  });

  test('the one-time code field asks for the numeric keyboard', async ({ page }) => {
    await page.goto('/sign-in');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Sign in with a code instead' }).click();
    await page.getByLabel('Email address').fill('someone@matchday.test');
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();

    const code = page.getByLabel('One-time code');
    await expect(code).toHaveAttribute('inputmode', 'numeric');
    // What lets iOS offer the code straight from the notification.
    await expect(code).toHaveAttribute('autocomplete', 'one-time-code');

    await expectNoHorizontalScroll(page, 'the code entry screen');
    await expectTouchTargets(page, 'the code entry screen');
  });

  test('the screens hold up in dark mode too', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });

    for (const { path, heading } of SCREENS) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await page.waitForLoadState('networkidle');

      await expectNoHorizontalScroll(page, `${path} in dark mode`);

      // Contrast is the thing a dark theme actually breaks, and it is the one
      // axe measures reliably.
      const results = await new AxeBuilder({ page }).withTags(['wcag2aa']).analyze();
      expect(
        results.violations.map((violation) => violation.id),
        `${path} has contrast or other WCAG AA violations in dark mode`,
      ).toEqual([]);
    }
  });

  test('every auth screen has exactly one h1', async ({ page }) => {
    for (const { path } of SCREENS) {
      await page.goto(path);
      await expect(page.locator('h1')).toHaveCount(1);
    }
  });
});

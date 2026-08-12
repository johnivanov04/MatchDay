import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { signInAs } from './auth';
import { TestDataFactory } from './factory';

/**
 * The fixtures every spec uses.
 *
 * `factory` opens one PostgreSQL connection per test and closes it afterwards,
 * so a test that fails cannot leak a connection into the next one.
 *
 * `asUser` is the only way a spec signs somebody in. It returns a page in a
 * fresh browser context, so two people can be signed in at once — which the
 * administrator/player journeys need constantly, and which sharing one context
 * would make impossible.
 */
export interface MatchdayFixtures {
  factory: TestDataFactory;
  asUser: (email: string) => Promise<Page>;
}

export const test = base.extend<MatchdayFixtures>({
  factory: async ({}, use) => {
    const factory = await TestDataFactory.connect();
    try {
      await use(factory);
    } finally {
      await factory.close();
    }
  },

  asUser: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];

    await use(async (email: string) => {
      const context = await browser.newContext();
      contexts.push(context);
      await signInAs(context, email);
      return context.newPage();
    });

    for (const context of contexts) {
      await context.close();
    }
  },
});

export { expect };

/**
 * Asserts a navigation ended somewhere authorized rather than on an error page.
 *
 * The repository's rule, learned three times over Phases 1–3B, is that an
 * expected authorization outcome must `redirect()` and never let a `DomainError`
 * escape a Server Component — which Next.js reports as an unhandled application
 * error. This is the browser-level check for that rule: the response is not a
 * 500 and the page is not the error boundary.
 */
export async function expectNoServerError(page: Page): Promise<void> {
  await expect(page.locator('body')).not.toContainText('Application error', { timeout: 5_000 });
  await expect(page.locator('body')).not.toContainText('Internal Server Error');
  await expect(page.locator('body')).not.toContainText('500');
}

/** Navigates and asserts the caller was redirected to `expectedPath`. */
export async function expectRedirectedTo(
  page: Page,
  from: string,
  expectedPath: string | RegExp,
): Promise<void> {
  const response = await page.goto(from);
  expect(response?.status() ?? 200).toBeLessThan(500);
  await expect(page).toHaveURL(
    typeof expectedPath === 'string' ? new RegExp(escapeRegExp(expectedPath)) : expectedPath,
  );
  await expectNoServerError(page);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

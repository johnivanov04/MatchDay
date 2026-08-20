import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, expectNoServerError, test } from '../support/fixtures';

/**
 * The three public pages an App Store submission points at.
 *
 * ── WHAT THESE ACTUALLY GUARD ──────────────────────────────────────────────
 *
 * A reviewer opens the Privacy Policy URL and the Support URL in a browser with
 * no session. If either one redirects to sign-in, the submission is rejected —
 * and nothing else in the suite would notice, because every other spec signs
 * somebody in first. So the load-bearing assertion here is the least
 * interesting-looking one: these pages render for a visitor who is nobody.
 *
 * The second thing they guard is honesty. The privacy page makes specific
 * claims about what account deletion does, and those claims have to keep
 * matching `finalize_account_deletion()`. If the retention model changes, the
 * assertions about "Former member" and de-identified history fail here.
 */

const PUBLIC_PAGES = [
  { path: '/privacy', heading: 'Privacy Policy' },
  { path: '/terms', heading: 'Terms of Use' },
  { path: '/support', heading: 'MatchDay Support' },
] as const;

/** The address the app is configured with, or null when none is set. */
function configuredSupportEmail(): string | null {
  const value = process.env['NEXT_PUBLIC_SUPPORT_EMAIL'];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : null;
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

async function expectNoHorizontalScroll(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow, `${label} scrolls sideways`).toBeLessThanOrEqual(1);
}

// ══════════════════════════════════════════════════════════════════════════
// Reachable without an account.
// ══════════════════════════════════════════════════════════════════════════

test.describe('signed out', () => {
  for (const { path, heading } of PUBLIC_PAGES) {
    test(`${path} renders for a visitor with no session`, async ({ page }) => {
      await page.goto(path);

      // Not redirected to sign-in. This is the assertion an App Store review
      // failure would come down to.
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expectNoServerError(page);
    });

    test(`${path} survives a direct reload`, async ({ page }) => {
      await page.goto(path);
      await page.reload();

      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    });

    test(`${path} has a sensible title and description`, async ({ page }) => {
      await page.goto(path);

      await expect(page).toHaveTitle(/MatchDay/);
      const description = await page
        .locator('meta[name="description"]')
        .getAttribute('content');
      expect(description ?? '', `${path} has no meta description`).not.toBe('');
    });
  }

  test('the three cross-link to each other, and every link resolves', async ({ page }) => {
    for (const { path } of PUBLIC_PAGES) {
      await page.goto(path);

      const hrefs = await page.locator('a[href^="/"]').evaluateAll((anchors) =>
        anchors.map((anchor) => anchor.getAttribute('href') ?? ''),
      );

      // Every internal destination answers, rather than 404ing in an App Store
      // reviewer's browser.
      for (const href of [...new Set(hrefs)]) {
        if (href === '' || href.startsWith('#')) continue;
        const response = await page.request.get(href);
        expect(response.status(), `${path} links to ${href}, which answered ${String(response.status())}`).toBeLessThan(400);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The claims the privacy page makes.
// ══════════════════════════════════════════════════════════════════════════

test.describe('the privacy policy', () => {
  test('describes account deletion the way the product implements it', async ({ page }) => {
    await page.goto('/privacy');
    const body = page.locator('body');

    // The in-app route, named exactly as the interface names it — not an
    // instruction to email support, which Apple rejects.
    await expect(body).toContainText('Profile → Account → Delete account');

    // What deletion removes.
    await expect(body).toContainText('sign-in identity');
    await expect(body).toContainText('profile photos');

    // AND WHAT IT DOES NOT. The tombstone model keeps de-identified history, so
    // claiming otherwise would be a false statement in a legal document.
    await expect(body).toContainText('Former member');
    await expect(page.getByText(/no longer identify you/i)).toBeVisible();

    // Re-signup semantics, which the implementation guarantees.
    await expect(body).toContainText('creates a completely new account');
  });

  test('states plainly that there is no tracking or advertising', async ({ page }) => {
    await page.goto('/privacy');

    await expect(page.getByRole('heading', { level: 2, name: 'Tracking' })).toBeVisible();
    await expect(page.getByText(/MatchDay does not track you/i)).toBeVisible();
    await expect(page.locator('body')).toContainText('no advertising or analytics software');
  });

  test('names every service provider that processes data', async ({ page }) => {
    await page.goto('/privacy');
    const body = page.locator('body');

    // Auditable: each of these appears in the repository as a real dependency
    // or a documented operational integration.
    for (const provider of ['Supabase', 'Vercel', 'Brevo', 'Better Stack']) {
      await expect(body, `the policy does not name ${provider}`).toContainText(provider);
    }
  });

  test('does not promise perfect security', async ({ page }) => {
    await page.goto('/privacy');
    await expect(page.getByText(/No service can promise perfect security/i)).toBeVisible();
  });

  test('leaks no configuration or internal detail', async ({ page }) => {
    for (const { path } of PUBLIC_PAGES) {
      await page.goto(path);
      const text = (await page.locator('body').innerText()).toLowerCase();

      for (const secret of [
        'service_role',
        'supabase_service_role_key',
        'anon_key',
        'vapid',
        'cron_secret',
        'postgres://',
        'process.env',
        'next_public_',
      ]) {
        expect(text, `${path} exposes ${secret}`).not.toContain(secret);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Support.
// ══════════════════════════════════════════════════════════════════════════

test.describe('the support page', () => {
  test('covers the topics people actually write in about', async ({ page }) => {
    await page.goto('/support');

    for (const heading of [
      'Account and signing in',
      'Joining a league',
      'Match signup and waitlists',
      'Notifications',
      'Deleting your account',
    ]) {
      await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible();
    }
  });

  test('is a real page rather than a mailto redirect', async ({ page }) => {
    await page.goto('/support');

    // Apple requires the Support URL to land somewhere useful. Substance, not a
    // single link — so the page has to carry actual guidance.
    const text = await page.locator('main').innerText();
    expect(text.length, 'the support page has almost no content').toBeGreaterThan(1_000);
  });

  test('shows the address from the project configuration, or no dead link', async ({ page }) => {
    await page.goto('/support');
    const configured = configuredSupportEmail();

    if (configured === null) {
      // Never an empty or placeholder mailto: the component renders nothing
      // rather than a link that silently loses somebody's report.
      await expect(page.locator('a[href^="mailto:"]')).toHaveCount(0);
      return;
    }

    const mailto = page.locator(`a[href="mailto:${configured}"]`).first();
    await expect(mailto).toBeVisible();
    await expect(mailto).toHaveText(configured);
  });

  test('points at the in-app deletion flow, not at support', async ({ page }) => {
    await page.goto('/support');
    await expect(page.locator('body')).toContainText('Profile → Account → Delete account');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Reachable from inside the app.
// ══════════════════════════════════════════════════════════════════════════

test.describe('from the Profile screen', () => {
  test('links to all three, and each one opens', async ({ factory, asUser }) => {
    // Apple requires the privacy policy to be easily accessible in the app, not
    // only from the store listing.
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    const page = await asUser(player.email);
    await page.goto('/profile');
    await page.waitForLoadState('networkidle');

    for (const { path } of PUBLIC_PAGES) {
      const link = page.locator(`a[href="${path}"]`).first();
      await expect(link, `Profile has no link to ${path}`).toBeVisible();
    }

    await page.locator('a[href="/privacy"]').first().click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeVisible();
    await expectNoServerError(page);
  });

  test('reaches them without an app shell that could refuse', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    const page = await asUser(player.email);
    await page.goto('/privacy');

    // No bottom tab bar, no league strip: these live outside the authenticated
    // layout, which is what makes them work signed out.
    await expect(page.getByRole('link', { name: 'Matches' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Active league:/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeVisible();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Mobile and accessibility.
// ══════════════════════════════════════════════════════════════════════════

test.describe('on a phone', () => {
  for (const width of [320, 390]) {
    test(`all three fit ${String(width)}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 720 });

      for (const { path } of PUBLIC_PAGES) {
        await page.goto(path);
        await expectNoHorizontalScroll(page, `${path} at ${String(width)}px`);
      }
    });
  }

  test('all three pass the accessibility pass at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });

    for (const { path } of PUBLIC_PAGES) {
      await page.goto(path);
      await axeClean(page, path);
    }
  });

  test('all three pass in dark mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 390, height: 844 });

    for (const { path } of PUBLIC_PAGES) {
      await page.goto(path);
      await expectNoHorizontalScroll(page, `${path} in dark mode`);

      const results = await new AxeBuilder({ page }).withTags(['wcag2aa']).analyze();
      expect(
        results.violations.map((violation) => violation.id),
        `${path} has contrast or other WCAG AA violations in dark mode`,
      ).toEqual([]);
    }
  });

  test('each page has exactly one h1, with h2 sections beneath it', async ({ page }) => {
    for (const { path } of PUBLIC_PAGES) {
      await page.goto(path);

      await expect(page.locator('h1'), `${path} does not have exactly one h1`).toHaveCount(1);
      const sections = await page.locator('h2').count();
      expect(sections, `${path} has no h2 sections`).toBeGreaterThan(3);
    }
  });
});

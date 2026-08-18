import type { Page } from '@playwright/test';
import { expect, expectNoServerError, expectRedirectedTo, test, settledUrl } from '../support/fixtures';

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

test.describe('the one-time code field', () => {
  /**
   * The production defect, at the layer it actually bit.
   *
   * `maxLength={6}` meant the browser silently discarded the seventh and eighth
   * characters of every real code — Supabase is configured to send eight — so
   * signing in by code was impossible on production no matter what the server
   * accepted. A unit test on the validator would not have caught it: the input
   * never let the value through.
   */
  async function openCodeField(page: Page) {
    await page.goto('/sign-in');
    await page.waitForLoadState('networkidle');
    // The code path is secondary to password sign-in now, so it has to be
    // chosen first. The acknowledgement is deliberately the same whether or not
    // the address has an account, so no real one is needed to reach the field.
    await page.getByRole('button', { name: 'Sign in with a code instead' }).click();
    await page.getByLabel('Email address').fill(`otp.probe.${Date.now()}@matchday.test`);
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    const field = page.getByLabel('One-time code');
    await expect(field).toBeVisible();
    return field;
  }

  test('accepts a full eight-digit production code without truncating it', async ({ page }) => {
    const field = await openCodeField(page);

    await field.fill('84726193');

    // The assertion that would have failed before the fix: the browser kept
    // only the first six characters.
    await expect(field).toHaveValue('84726193');
  });

  test('accepts the ten-digit maximum', async ({ page }) => {
    const field = await openCodeField(page);

    await field.fill('1234567890');

    await expect(field).toHaveValue('1234567890');
  });

  test('preserves a leading zero', async ({ page }) => {
    const field = await openCodeField(page);

    await field.fill('00123456');

    await expect(field).toHaveValue('00123456');
  });

  test('still stops at ten characters', async ({ page }) => {
    const field = await openCodeField(page);

    await field.fill('123456789012345');

    // maxLength still applies — it is simply the right maximum now.
    await expect(field).toHaveValue('1234567890');
  });

  test('is labelled without naming a length, and asks for a numeric keypad', async ({ page }) => {
    const field = await openCodeField(page);

    // "6-digit code" was wrong the moment Supabase was configured for eight.
    await expect(page.getByText(/6-digit/)).toHaveCount(0);
    await expect(field).toHaveAttribute('inputmode', 'numeric');
    await expect(field).toHaveAttribute('pattern', '[0-9]{6,10}');
    // Keeps iOS autofill working from the mail notification.
    await expect(field).toHaveAttribute('autocomplete', 'one-time-code');
  });
});

test.describe('the magic-link interstitial, legacy link shape', () => {
  /**
   * `/auth/continue` exists because a one-time sign-in link is often opened by
   * something other than its recipient — Brevo rewrites every link through its
   * click tracker, and mail scanners fetch links to inspect them. Either
   * consumes the token before the human sees it.
   *
   * These run signed out, with no fixtures, because the page must work for
   * somebody who has no session at all — which is everybody who reaches it.
   */
  const confirmationUrl = (base: string) =>
    `${base}/auth/v1/verify?token=pkce_e2e_probe&type=magiclink&redirect_to=${encodeURIComponent(
      'http://127.0.0.1:3100/auth/callback?next=%2Fdashboard',
    )}`;

  test('renders a button and navigates nowhere on its own', async ({ page }) => {
    const supabaseUrl = process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
    const target = confirmationUrl(supabaseUrl);

    // Fail loudly if anything requests the confirmation URL without a click.
    // This is the whole point of the page: a request here means the token was
    // spent by the render, exactly as a scanner would spend it.
    const unattendedRequests: string[] = [];
    await page.route('**/auth/v1/verify**', async (route) => {
      unattendedRequests.push(route.request().url());
      await route.abort();
    });

    await page.goto(`/auth/continue?confirmation_url=${encodeURIComponent(target)}`);
    await expect(page.getByRole('link', { name: 'Continue to MatchDay' })).toBeVisible();

    // Give any effect, timer, meta refresh or prefetch a generous chance to
    // fire. Nothing should.
    await page.waitForLoadState('networkidle');

    expect(unattendedRequests, 'the confirmation URL was requested without a click').toEqual([]);
    expect(new URL(page.url()).pathname).toBe('/auth/continue');
  });

  test('follows the confirmation URL only when the human clicks', async ({ page }) => {
    const supabaseUrl = process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
    const target = confirmationUrl(supabaseUrl);

    const requested: string[] = [];
    await page.route('**/auth/v1/verify**', async (route) => {
      requested.push(route.request().url());
      // Aborted rather than fulfilled: this test is about *when* the request
      // happens, and the token is a fake one Supabase would reject anyway.
      await route.abort();
    });

    await page.goto(`/auth/continue?confirmation_url=${encodeURIComponent(target)}`);
    await page.waitForLoadState('networkidle');
    expect(requested).toEqual([]);

    await page.getByRole('link', { name: 'Continue to MatchDay' }).click();
    await expect.poll(() => requested.length).toBeGreaterThan(0);
  });

  test('shows a safe error and no external link for a foreign confirmation URL', async ({
    page,
  }) => {
    await page.goto(
      `/auth/continue?confirmation_url=${encodeURIComponent(
        'https://evil.example/auth/v1/verify?token=abc',
      )}`,
    );

    await expect(page.getByText(/expired/i)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue to MatchDay' })).toHaveCount(0);
    // The rejected destination must not be rendered as a link anywhere.
    await expect(page.locator('a[href*="evil.example"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Get a new link' })).toBeVisible();
  });

  test('shows the same error when the parameter is missing entirely', async ({ page }) => {
    await page.goto('/auth/continue');

    await expect(page.getByText(/expired/i)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Get a new link' })).toBeVisible();
  });

  test('still sends a signed-out visitor to sign in from protected routes', async ({ page }) => {
    // The interstitial adds a route under /auth; this confirms it changed
    // nothing about the existing guard behaviour.
    await expectRedirectedTo(page, '/dashboard', '/sign-in');
  });
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

    // Which league is active without a stored preference is decided by league
    // name, and the factory's names carry a random token — so the one being
    // switched *to* is pinned as the one not currently active.
    await factory.query(
      `insert into public.user_app_state (user_id, active_league_id) values ($1, $2)
         on conflict (user_id) do update set active_league_id = excluded.active_league_id`,
      [member.id, first.id],
    );

    const page = await asUser(member.email);
    await page.goto('/dashboard');

    // The control moved: this was a `<select>` and a Switch button on the
    // dashboard, and is now the league menu behind the active-league strip,
    // which is reachable from every screen rather than from this one. The
    // server action underneath is the same one — see phase9-league-menu.spec.ts
    // for the menu's own behaviour. What this test still owns is the tenancy
    // property: one person, two leagues, and a choice that sticks.
    await page.getByRole('button', { name: /^Active league:/ }).click();
    const menu = page.getByRole('dialog');
    await expect(menu.getByText(first.name)).toBeVisible();
    await expect(menu.getByText(second.name)).toBeVisible();

    // Switching is a real form post that writes `user_app_state`. Asserting on
    // the stored row rather than on the rendered strip immediately after the
    // click: the strip comes from a fresh server render, so reading it straight
    // away races the revalidation.
    await menu.getByRole('button', { name: new RegExp(second.name) }).click();

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
    await expect(page.getByRole('button', { name: /^Active league:/ })).toContainText(second.name);
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

  const unknownUrl = await settledUrl(page, '/leagues/definitely-not-a-real-league/matches');
  const forbiddenUrl = await settledUrl(page, `/leagues/${other.slug}/matches`);

  // Identical, so a guessed slug cannot confirm a private league exists.
  expect(unknownUrl).toBe(forbiddenUrl);
  await expectNoServerError(page);
});

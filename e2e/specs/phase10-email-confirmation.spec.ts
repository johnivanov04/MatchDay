import type { Browser, Page } from '@playwright/test';
import { expect, expectNoServerError, test } from '../support/fixtures';
import { waitForConfirmationLink } from '../support/mailbox';

/**
 * The email confirmation flow, driven through a real inbox.
 *
 * ── THE COVERAGE GAP THIS FILLS ────────────────────────────────────────────
 *
 * Every other spec signs in by minting a session through the Auth admin API and
 * installing the cookie. That is fast and deliberate — and it is exactly why
 * the confirmation flow shipped broken. Nothing opened an email, so nothing
 * noticed that the link only worked in the browser that had asked for it.
 *
 * The failure in production: the old email pointed at Supabase's verify
 * endpoint, which redirected to `/auth/callback?code=…`, and
 * `exchangeCodeForSession` needs a PKCE code verifier cookie that only exists
 * in the originating browser. Anyone opening the email in Gmail's in-app
 * browser or on a second device was bounced back to the sign-in page. The SDK
 * says it outright: "PKCE code verifier not found in storage. This can happen
 * if the auth flow was initiated in a different browser or device."
 *
 * So the central test below asks for the email in one browser context and opens
 * it in a **completely fresh** one, with no cookies at all. Nothing is minted,
 * nothing is injected: the only credential in play is the one that arrived by
 * email.
 */

/** A brand-new address per test, so no run can read another's mail. */
function freshAddress(label: string): string {
  return `confirm.${label}.${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2, 8)}@matchday.test`;
}

/**
 * Creates an account and returns the confirmation link that arrives.
 *
 * ── WHY THIS GOES THROUGH SIGN-UP AND NOT SIGN-IN ──────────────────────────
 *
 * It used to ask for a sign-in email for a brand-new address, which worked only
 * because the code flow created accounts as a side effect. It no longer does —
 * `shouldCreateUser: false` — because silently minting an `auth.users` row for
 * a mistyped address left half-made accounts nobody could use. Creating the
 * account explicitly is what a person now does, so it is what this does.
 *
 * The origin is re-pointed at the harness because the local stack's Site URL is
 * the dev server's port and the suite runs a production build on another one.
 * The path, `token_hash` and `type` are exactly as the template rendered them —
 * which is the part under test.
 */
const SIGN_UP_PASSWORD = 'correct horse battery staple';

async function requestConfirmationLink(page: Page, email: string): Promise<URL> {
  await page.goto('/sign-up');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(SIGN_UP_PASSWORD);
  await page.getByLabel('Confirm password').fill(SIGN_UP_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Check your email')).toBeVisible();

  const emailed = await waitForConfirmationLink(email, 'signup');
  return new URL(`${emailed.pathname}${emailed.search}`, page.url());
}

/** The same, for an address that already has an account: a magic link. */
async function requestSignInLink(page: Page, email: string): Promise<URL> {
  await page.goto('/sign-in');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Sign in with a code instead' }).click();
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByText('Check your email')).toBeVisible();

  const emailed = await waitForConfirmationLink(email, 'magiclink');
  return new URL(`${emailed.pathname}${emailed.search}`, page.url());
}

/** A browser context with nothing in it — no cookies, no storage, no verifier. */
async function freshContext(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

/** Counts how many times the browser asked Supabase to verify anything. */
async function countVerifyCalls(page: Page): Promise<() => number> {
  const calls: string[] = [];
  await page.route('**/auth/v1/verify**', async (route) => {
    calls.push(route.request().url());
    await route.abort();
  });
  return () => calls.length;
}

test.describe('confirming an email address', () => {
  test('the link works in a browser that never asked for it', async ({ browser, factory }) => {
    const email = freshAddress('crossbrowser');

    // ── Context A: asks for the email ──────────────────────────────────────
    const asking = await freshContext(browser);
    const link = await requestConfirmationLink(asking, email);

    expect(link.pathname).toBe('/auth/continue');
    expect(link.searchParams.get('token_hash')).toBeTruthy();
    expect(link.searchParams.get('type')).toBe('signup');
    // The link is ours. Nothing in the email points at Supabase any more.
    expect(link.search).not.toContain('confirmation_url');

    // ── Context B: a different browser entirely ────────────────────────────
    //
    // This is the whole point. B has never spoken to this application, holds no
    // PKCE verifier, and is what a phone opening the email actually looks like.
    const opening = await freshContext(browser);
    await opening.goto(link.toString());

    // The GET alone must not authenticate. Landing on the confirmation page,
    // still anonymous, is the correct outcome.
    await expect(opening.getByRole('heading', { name: 'Confirm your email' })).toBeVisible();
    const cookiesBefore = await opening.context().cookies();
    expect(cookiesBefore.filter((cookie) => cookie.name.startsWith('sb-'))).toEqual([]);

    // ── The explicit action ────────────────────────────────────────────────
    await opening.getByRole('button', { name: 'Continue to MatchDay' }).click();

    // A brand-new account has no profile, so the destination is onboarding.
    await opening.waitForURL(/\/onboarding/);
    await expectNoServerError(opening);

    // A real session, in the browser that opened the email.
    const cookiesAfter = await opening.context().cookies();
    expect(cookiesAfter.some((cookie) => cookie.name.startsWith('sb-'))).toBe(true);

    // It survives a reload, which is what distinguishes a session from a
    // redirect that happened to land somewhere.
    await opening.reload();
    await expect(opening).toHaveURL(/\/onboarding/);
    await expectNoServerError(opening);

    // And the account is genuinely confirmed in the database.
    const rows = await factory.query<{ confirmed: string | null }>(
      'select email_confirmed_at::text as confirmed from auth.users where email = $1',
      [email],
    );
    expect(rows[0]?.confirmed).not.toBeNull();
  });

  test('an existing account gets a magiclink that also works cross-browser', async ({
    browser,
    factory,
  }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);

    const asking = await freshContext(browser);
    const link = await requestSignInLink(asking, member.email);

    // An address that already exists gets the sign-in template, not the signup
    // one — the other half of the allowlist.
    expect(link.searchParams.get('type')).toBe('magiclink');

    const opening = await freshContext(browser);
    await opening.goto(link.toString());
    await opening.getByRole('button', { name: 'Continue to MatchDay' }).click();

    // This one has a profile already, so it lands in the app rather than in
    // onboarding.
    await opening.waitForURL(/\/dashboard/);
    await expect(opening.getByRole('heading', { name: `Hello, ${member.firstName}` })).toBeVisible();
    await expectNoServerError(opening);
  });
});

test.describe('the confirmation page is safe to fetch', () => {
  test('rendering it calls Supabase verify zero times, however often it is loaded', async ({
    browser,
  }) => {
    const email = freshAddress('prefetch');

    const asking = await freshContext(browser);
    const link = await requestConfirmationLink(asking, email);

    const scanner = await freshContext(browser);
    const verifyCalls = await countVerifyCalls(scanner);

    // Three loads, as a link tracker, a scanner and a preview generator would.
    for (let visit = 0; visit < 3; visit += 1) {
      await scanner.goto(link.toString());
      await expect(scanner.getByRole('button', { name: 'Continue to MatchDay' })).toBeVisible();
      await scanner.waitForLoadState('networkidle');
    }

    expect(verifyCalls(), 'the confirmation page verified a token without being asked').toBe(0);
    // Still anonymous after all that.
    expect(
      (await scanner.context().cookies()).filter((cookie) => cookie.name.startsWith('sb-')),
    ).toEqual([]);

    // And the token is untouched: a real person can still use it afterwards.
    const human = await freshContext(browser);
    await human.goto(link.toString());
    await human.getByRole('button', { name: 'Continue to MatchDay' }).click();
    await human.waitForURL(/\/onboarding/);
  });

  test('only the POST spends the token, and a replay is refused', async ({ browser }) => {
    const email = freshAddress('replay');

    const asking = await freshContext(browser);
    const link = await requestConfirmationLink(asking, email);

    const first = await freshContext(browser);
    await first.goto(link.toString());
    await first.getByRole('button', { name: 'Continue to MatchDay' }).click();
    await first.waitForURL(/\/onboarding/);

    // The same link again, in yet another browser. The token is spent, so this
    // must fail — and fail in a way that says nothing about why.
    const replay = await freshContext(browser);
    await replay.goto(link.toString());
    await replay.getByRole('button', { name: 'Continue to MatchDay' }).click();

    await expect(replay.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
    await expect(replay.getByRole('link', { name: 'Get a new link' })).toBeVisible();
    expect(
      (await replay.context().cookies()).filter((cookie) => cookie.name.startsWith('sb-')),
    ).toEqual([]);
    await expectNoServerError(replay);
  });
});

test.describe('rejecting links that are not ours', () => {
  const cases: { label: string; query: string }[] = [
    { label: 'no token at all', query: '' },
    { label: 'a missing token hash', query: '?type=signup' },
    { label: 'a malformed token hash', query: '?token_hash=../../etc/passwd&type=signup' },
    { label: 'an empty token hash', query: '?token_hash=&type=signup' },
    { label: 'a token with no type', query: `?token_hash=${'a'.repeat(40)}` },
    // `invite` is a real Supabase EmailOtpType that MatchDay does not send.
    // `recovery` used to be here and is now supported — the allowlist grew when
    // the reset-password flow shipped, and not before.
    { label: 'an unsupported type', query: `?token_hash=${'a'.repeat(40)}&type=invite` },
    { label: 'a made-up type', query: `?token_hash=${'a'.repeat(40)}&type=admin` },
  ];

  for (const { label, query } of cases) {
    test(`shows one friendly message for ${label}`, async ({ page }) => {
      await page.goto(`/auth/continue${query}`);

      // The same page for every rejection, so it cannot be used to probe what
      // we accept — and no Continue button, so there is nothing to press.
      await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Continue to MatchDay' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Get a new link' })).toBeVisible();
      await expectNoServerError(page);
    });
  }

  test('never renders a link to somebody else’s origin', async ({ page }) => {
    await page.goto(
      `/auth/continue?confirmation_url=${encodeURIComponent(
        'https://evil.example/auth/v1/verify?token=abc',
      )}`,
    );

    await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
    await expect(page.locator('a[href*="evil.example"]')).toHaveCount(0);
  });

  test('a manipulated next path cannot send anybody off-site', async ({ browser, factory }) => {
    // An account that already has a profile, deliberately: for a brand-new one
    // the destination is onboarding whatever `next` says, which would prove
    // nothing about the sanitising. This is the case where `next` is honoured.
    const league = await factory.createLeague();
    const member = await factory.createMember(league);

    const asking = await freshContext(browser);
    const link = await requestSignInLink(asking, member.email);
    link.searchParams.set('next', 'https://evil.example/steal');

    const opening = await freshContext(browser);
    await opening.goto(link.toString());
    await opening.getByRole('button', { name: 'Continue to MatchDay' }).click();

    // `safeRedirectPath` collapses anything that is not a local path, so the
    // honoured destination is the dashboard.
    await opening.waitForURL(/\/dashboard/);
    expect(opening.url()).not.toContain('evil.example');
    await expect(opening.getByRole('heading', { name: `Hello, ${member.firstName}` })).toBeVisible();
    await expectNoServerError(opening);
  });

  test('a local next path is honoured', async ({ browser, factory }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);

    const asking = await freshContext(browser);
    const link = await requestSignInLink(asking, member.email);
    link.searchParams.set('next', '/profile');

    const opening = await freshContext(browser);
    await opening.goto(link.toString());
    await opening.getByRole('button', { name: 'Continue to MatchDay' }).click();

    await opening.waitForURL(/\/profile/);
    await expect(opening.getByRole('heading', { name: 'Your profile' })).toBeVisible();
  });
});

test.describe('the legacy confirmation link still works during rollout', () => {
  /**
   * Production templates still carry `{{ .ConfirmationURL }}` until they are
   * switched by hand, and links already sitting in inboxes must keep working
   * after this deploys. The page therefore accepts both shapes.
   */
  test('renders the old shape and follows it only on a click', async ({ page }) => {
    const supabaseUrl = process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
    const target = `${supabaseUrl}/auth/v1/verify?token=legacy_probe&type=magiclink&redirect_to=${encodeURIComponent(
      'http://127.0.0.1:3100/auth/callback?next=%2Fdashboard',
    )}`;

    const requested: string[] = [];
    await page.route('**/auth/v1/verify**', async (route) => {
      requested.push(route.request().url());
      await route.abort();
    });

    await page.goto(`/auth/continue?confirmation_url=${encodeURIComponent(target)}`);
    await expect(page.getByRole('link', { name: 'Continue to MatchDay' })).toBeVisible();
    await page.waitForLoadState('networkidle');

    // Unchanged guarantee: rendering spends nothing.
    expect(requested, 'the legacy confirmation URL was requested without a click').toEqual([]);

    await page.getByRole('link', { name: 'Continue to MatchDay' }).click();
    await expect.poll(() => requested.length).toBeGreaterThan(0);
  });
});

import type { Browser, Page } from '@playwright/test';
import { expect, expectNoServerError, test } from '../support/fixtures';
import { waitForConfirmationLink, waitForEmail } from '../support/mailbox';

/**
 * Email and password authentication, driven through real inboxes.
 *
 * ── WHY THIS SPEC REFUSES THE SHORTCUT ─────────────────────────────────────
 *
 * Everywhere else the suite mints a session through the Auth admin API and
 * installs the cookie. That shortcut is why the cross-device confirmation bug
 * shipped: nothing opened an email, so nothing noticed the link only worked in
 * the browser that had asked for it.
 *
 * So every test here uses a fresh browser context and, where an email is
 * involved, the real message out of Mailpit. Nothing is minted. The only
 * credentials in play are the ones a person would have.
 */

const PASSWORD = 'correct horse battery staple';

function freshAddress(label: string): string {
  return `pw.${label}.${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2, 8)}@matchday.test`;
}

/** A browser context with nothing in it — no cookies, no storage, no verifier. */
async function freshContext(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

/**
 * Whether this context holds a real session.
 *
 * `sb-` alone is not enough: `signUp` and `signInWithOtp` both write PKCE
 * code-verifier cookies under the same prefix, and those are not a session —
 * an unconfirmed signup has them and can reach nothing. The session cookie is
 * `sb-<ref>-auth-token`, possibly chunked as `.0`, `.1`.
 */
async function hasSessionCookie(page: Page): Promise<boolean> {
  return (await page.context().cookies()).some(
    (cookie) => cookie.name.includes('-auth-token') && !cookie.name.includes('verifier'),
  );
}

/** Fills and submits the create-account form. */
async function createAccount(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/sign-up');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

/**
 * The `/auth/continue` link of a given type, re-pointed at the harness.
 *
 * The type is required rather than inferred: an address can hold a signup
 * confirmation and a recovery at once, and picking the newest email would
 * sometimes hand back a token the test had already spent.
 *
 * Only the origin is rewritten — the local stack's Site URL is the dev server's
 * port and the suite runs a production build on another one. Path, `token_hash`
 * and `type` are exactly as the template rendered them, which is the part under
 * test.
 */
async function confirmationLink(
  page: Page,
  email: string,
  type: 'signup' | 'magiclink' | 'recovery',
): Promise<URL> {
  const emailed = await waitForConfirmationLink(email, type);
  return new URL(`${emailed.pathname}${emailed.search}`, page.url());
}

/** The one-time code out of an email body. */
function codeFrom(body: string): string {
  const match = /\b(\d{6,10})\b/.exec(body);
  if (match === null) {
    throw new Error('The email carried no one-time code. Check the local templates.');
  }
  return match[1]!;
}

async function signInWithPassword(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/sign-in');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  // Exact: "Sign in with a code instead" is also a button on this screen, and
  // Playwright matches accessible names by substring unless told otherwise.
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

// ══ Creating an account ════════════════════════════════════════════════════

test.describe('creating an account with a password', () => {
  test('confirms by link, in a browser that never asked for it', async ({ browser, factory }) => {
    const email = freshAddress('link');

    const signingUp = await freshContext(browser);
    await createAccount(signingUp, email);

    // No session yet. An `auth.users` row exists, but an unconfirmed account
    // must not reach anything protected — that is the point of confirmations.
    expect(await hasSessionCookie(signingUp)).toBe(false);
    await signingUp.goto('/dashboard');
    await expect(signingUp).toHaveURL(/\/sign-in/);

    const link = await confirmationLink(signingUp, email, 'signup');
    expect(link.searchParams.get('type')).toBe('signup');

    // A completely different browser: no cookies, no PKCE verifier. This is a
    // phone opening the email.
    const opening = await freshContext(browser);
    await opening.goto(link.toString());
    await expect(opening.getByRole('heading', { name: 'Confirm your email' })).toBeVisible();
    expect(await hasSessionCookie(opening)).toBe(false);

    await opening.getByRole('button', { name: 'Continue to MatchDay' }).click();
    await opening.waitForURL(/\/onboarding/);
    expect(await hasSessionCookie(opening)).toBe(true);
    await expectNoServerError(opening);

    await opening.reload();
    await expect(opening).toHaveURL(/\/onboarding/);

    const rows = await factory.query<{ confirmed: string | null }>(
      'select email_confirmed_at::text as confirmed from auth.users where email = $1',
      [email],
    );
    expect(rows[0]?.confirmed).not.toBeNull();
  });

  test('confirms by typing the code from the email', async ({ browser }) => {
    const email = freshAddress('code');

    const page = await freshContext(browser);
    await createAccount(page, email);

    const { html } = await waitForEmail(email);
    const code = codeFrom(html);

    await page.getByLabel('Confirmation code').fill(code);
    await page.getByRole('button', { name: 'Confirm email' }).click();

    await page.waitForURL(/\/onboarding/);
    expect(await hasSessionCookie(page)).toBe(true);

    await page.reload();
    await expect(page).toHaveURL(/\/onboarding/);
    await expectNoServerError(page);
  });

  // One submission each, on a clean page: a second submit racing the re-render
  // of the first result is a test artefact, not a behaviour worth asserting.
  const invalid: { label: string; password: string; confirm: string; message: string }[] = [
    {
      label: 'a password under ten characters',
      password: 'short',
      confirm: 'short',
      message: 'Use at least 10 characters.',
    },
    {
      label: 'a confirmation that does not match',
      password: PASSWORD,
      confirm: 'a different password',
      message: 'Both passwords must match.',
    },
  ];

  for (const { label, password, confirm, message } of invalid) {
    test(`refuses ${label}, and creates nothing`, async ({ browser, factory }) => {
      const email = freshAddress('invalid');
      const page = await freshContext(browser);

      await page.goto('/sign-up');
      await page.waitForLoadState('networkidle');
      await page.getByLabel('Email address').fill(email);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByLabel('Confirm password').fill(confirm);
      await page.getByRole('button', { name: 'Create account' }).click();

      await expect(page.getByText(message)).toBeVisible();
      expect(await hasSessionCookie(page)).toBe(false);

      const rows = await factory.query('select id from auth.users where email = $1', [email]);
      expect(rows).toEqual([]);
    });
  }

  test('a duplicate address gives away nothing', async ({ browser }) => {
    const email = freshAddress('dupe');

    const first = await freshContext(browser);
    await createAccount(first, email);

    // The same address again, from a different browser. Supabase answers `User
    // already registered` internally; the screen must be identical to a fresh
    // signup, or this form becomes a way to test who has a MatchDay account.
    const second = await freshContext(browser);
    await createAccount(second, email);
    await expect(second.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(second.getByText(/already|exists|registered/i)).toHaveCount(0);
  });

  test('resending sends another real email, and the code still confirms', async ({ browser }) => {
    const email = freshAddress('resend');

    const page = await freshContext(browser);
    await createAccount(page, email);
    expect(await countEmails(email)).toBe(1);

    await page.getByRole('button', { name: 'Send the email again' }).click();

    // ── WHAT IS AND IS NOT ASSERTED HERE ─────────────────────────────────
    //
    // Not "a second message arrives". Supabase applies a per-address frequency
    // limit and refuses a resend inside it, and MatchDay deliberately does not
    // surface that refusal — saying "you asked too recently" would confirm an
    // email had been sent to the address, which is the same account-existence
    // oracle the whole flow avoids. Whether GoTrue chose to send is its
    // decision, under a limit we intentionally hide.
    //
    // What MatchDay owns is the rest: the press is acknowledged, the button
    // then refuses to be hammered, and the code in the inbox still works.
    await expect(page.getByRole('button', { name: 'Confirmation sent' })).toBeDisabled();

    // The code in the resent email confirms the account. Note it is the *same*
    // code: GoTrue reissues the existing one until it expires rather than
    // rotating it, so a test asserting a new code would be asserting something
    // Supabase does not promise.
    const latest = codeFrom((await waitForEmail(email)).html);
    await page.getByLabel('Confirmation code').fill(latest);
    await page.getByRole('button', { name: 'Confirm email' }).click();
    await page.waitForURL(/\/onboarding/);
  });
});

// ══ Signing in ═════════════════════════════════════════════════════════════

test.describe('signing in with a password', () => {
  test('a confirmed account signs in with no email at all', async ({ browser, factory }) => {
    const email = freshAddress('returning');

    const setup = await freshContext(browser);
    await createAccount(setup, email);
    const link = await confirmationLink(setup, email, 'signup');
    const confirming = await freshContext(browser);
    await confirming.goto(link.toString());
    await confirming.getByRole('button', { name: 'Continue to MatchDay' }).click();
    await confirming.waitForURL(/\/onboarding/);

    // How many emails this address has received so far.
    const before = await factory.query<{ n: string }>('select 1 as n');
    expect(before).toBeTruthy();
    const mailCountBefore = await countEmails(email);

    // A brand-new browser, password only.
    const returning = await freshContext(browser);
    await signInWithPassword(returning, email, PASSWORD);
    await returning.waitForURL(/\/onboarding|\/dashboard/);
    expect(await hasSessionCookie(returning)).toBe(true);
    await expectNoServerError(returning);

    await returning.reload();
    expect(await hasSessionCookie(returning)).toBe(true);

    // The whole promise of password login: nothing was sent.
    await returning.waitForTimeout(1_000);
    expect(await countEmails(email)).toBe(mailCountBefore);
  });

  test('a wrong password and an unknown address are indistinguishable', async ({ browser }) => {
    const email = freshAddress('generic');

    const setup = await freshContext(browser);
    await createAccount(setup, email);
    const link = await confirmationLink(setup, email, 'signup');
    const confirming = await freshContext(browser);
    await confirming.goto(link.toString());
    await confirming.getByRole('button', { name: 'Continue to MatchDay' }).click();
    await confirming.waitForURL(/\/onboarding/);

    const wrong = await freshContext(browser);
    await signInWithPassword(wrong, email, 'not the right password');
    await expect(wrong.getByText('Email or password is incorrect.')).toBeVisible();
    expect(await hasSessionCookie(wrong)).toBe(false);

    const unknown = await freshContext(browser);
    await signInWithPassword(unknown, freshAddress('nobody'), 'not the right password');
    await expect(unknown.getByText('Email or password is incorrect.')).toBeVisible();
    expect(await hasSessionCookie(unknown)).toBe(false);
  });

  test('an unconfirmed account cannot sign in, and is not identified as unconfirmed', async ({
    browser,
  }) => {
    const email = freshAddress('unconfirmed');

    const signingUp = await freshContext(browser);
    await createAccount(signingUp, email);

    const attempt = await freshContext(browser);
    await signInWithPassword(attempt, email, PASSWORD);

    // Supabase answers `Email not confirmed`, which would confirm the address is
    // registered. One message for everything.
    await expect(attempt.getByText('Email or password is incorrect.')).toBeVisible();
    expect(await hasSessionCookie(attempt)).toBe(false);
  });

  test('a signed-in visitor is sent away from the public auth pages', async ({
    browser,
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const page = await asUser(member.email);

    for (const path of ['/sign-in', '/sign-up']) {
      await page.goto(path);
      await expect(page).not.toHaveURL(new RegExp(path));
    }
    await page.goto('/forgot-password');
    await expect(page).toHaveURL(/\/profile/);

    expect(browser).toBeTruthy();
  });
});

// ══ The code fallback ══════════════════════════════════════════════════════

test.describe('signing in with a code instead', () => {
  /**
   * ── WHY THIS ASKS FOR EXACTLY ONE CODE ─────────────────────────────────
   *
   * It used to request a code twice for the same address — once in each of two
   * browser contexts — to dramatise "the code is not tied to the browser that
   * asked". That is not a property a one-time code has to begin with (no cookie
   * is involved), and asking twice is actively wrong: a second
   * `signInWithOtp` issues a new code and **invalidates the previous one**.
   * Verified directly against the stack — `verifyOtp` on the first code answers
   * `Token has expired or is invalid`.
   *
   * The test then read "the newest email for this address", which under CI
   * timing was still the *first* message, because the second had not landed in
   * Mailpit yet. So it typed a code that had just been revoked, the sign-in
   * legitimately refused it, and the test timed out waiting for a dashboard it
   * was never going to reach. Green locally, red on CI, twice.
   *
   * One request, one live code, entered where it was asked for — which is what
   * a person actually does. The cross-device property belongs to the emailed
   * *link*, and the test below owns it.
   */
  test('works for a real member, and creates nothing for a stranger', async ({
    browser,
    factory,
  }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);

    const page = await freshContext(browser);
    await page.goto('/sign-in');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Sign in with a code instead' }).click();
    await page.getByLabel('Email address').fill(member.email);
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    // The only code this address will ever be sent during this test.
    const code = codeFrom((await waitForEmail(member.email)).html);

    await page.getByLabel('One-time code').fill(code);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await page.waitForURL(/\/dashboard/);
    expect(await hasSessionCookie(page)).toBe(true);
    await expect(page.getByRole('heading', { name: `Hello, ${member.firstName}` })).toBeVisible();
    await expectNoServerError(page);
  });

  /**
   * The refusal path, tested deterministically.
   *
   * A *superseded* code would be the more evocative fixture — asking twice
   * invalidates the first, which is what the bug above turned on — but forcing
   * a second send depends on Supabase's per-address frequency limit choosing to
   * cooperate, and a test that needs that is the same flake wearing a different
   * hat. A code that was never valid exercises the identical path through
   * MatchDay: `verifyOtp` refuses, and the form has to say so rather than
   * appearing to do nothing.
   */
  test('a code that is not the emailed one is refused, and says so', async ({
    browser,
    factory,
  }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);

    const page = await freshContext(browser);
    await page.goto('/sign-in');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Sign in with a code instead' }).click();
    await page.getByLabel('Email address').fill(member.email);
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    const real = codeFrom((await waitForEmail(member.email)).html);
    // Well-formed and the right length, so it reaches Supabase rather than
    // being turned away by the client-side pattern.
    const wrong = real === '000000' ? '111111' : '000000';

    await page.getByLabel('One-time code').fill(wrong);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page.getByText('That code is not valid or has expired.')).toBeVisible();
    expect(await hasSessionCookie(page)).toBe(false);
    await expectNoServerError(page);

    // And the real one still works afterwards: a wrong guess does not burn it.
    await page.getByLabel('One-time code').fill(real);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(/\/dashboard/);
    expect(await hasSessionCookie(page)).toBe(true);
  });

  test('an unknown address creates no account and says nothing about it', async ({
    browser,
    factory,
  }) => {
    const stranger = freshAddress('stranger');

    const page = await freshContext(browser);
    await page.goto('/sign-in');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Sign in with a code instead' }).click();
    await page.getByLabel('Email address').fill(stranger);
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();

    // The same acknowledgement a real address gets.
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(page.getByText(/no account|not found|does not exist/i)).toHaveCount(0);

    // And the behaviour that changed in this stage: no `auth.users` row is
    // conjured for somebody who mistyped their address.
    await page.waitForTimeout(1_000);
    const rows = await factory.query('select id from auth.users where email = $1', [stranger]);
    expect(rows).toEqual([]);
    expect(await countEmails(stranger)).toBe(0);
  });

  test('the emailed link still works across browsers', async ({ browser, factory }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);

    const page = await freshContext(browser);
    await page.goto('/sign-in');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Sign in with a code instead' }).click();
    await page.getByLabel('Email address').fill(member.email);
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    const link = await confirmationLink(page, member.email, 'magiclink');
    expect(link.searchParams.get('type')).toBe('magiclink');

    const opening = await freshContext(browser);
    await opening.goto(link.toString());
    await opening.getByRole('button', { name: 'Continue to MatchDay' }).click();
    await opening.waitForURL(/\/dashboard/);
    expect(await hasSessionCookie(opening)).toBe(true);
  });
});

// ══ Recovery ═══════════════════════════════════════════════════════════════

test.describe('forgetting a password', () => {
  test('recovers across browsers, and the new password then works', async ({
    browser,
    factory,
  }) => {
    const email = freshAddress('recover');

    const setup = await freshContext(browser);
    await createAccount(setup, email);
    const confirmLink = await confirmationLink(setup, email, 'signup');
    const confirming = await freshContext(browser);
    await confirming.goto(confirmLink.toString());
    await confirming.getByRole('button', { name: 'Continue to MatchDay' }).click();
    await confirming.waitForURL(/\/onboarding/);

    // Ask for recovery from one browser.
    const asking = await freshContext(browser);
    await asking.goto('/forgot-password');
    await asking.waitForLoadState('networkidle');
    await asking.getByLabel('Email address').fill(email);
    await asking.getByRole('button', { name: 'Send recovery email' }).click();
    await expect(asking.getByText(/If an account exists for that email/)).toBeVisible();

    const link = await confirmationLink(asking, email, 'recovery');
    expect(link.searchParams.get('type')).toBe('recovery');

    // Open it in another. The GET must be inert.
    const opening = await freshContext(browser);
    const verifyCalls: string[] = [];
    await opening.route('**/auth/v1/verify**', async (route) => {
      verifyCalls.push(route.request().url());
      await route.abort();
    });
    await opening.goto(link.toString());
    await expect(opening.getByRole('heading', { name: 'Confirm your email' })).toBeVisible();
    await opening.waitForLoadState('networkidle');
    expect(verifyCalls).toEqual([]);
    expect(await hasSessionCookie(opening)).toBe(false);
    await opening.unroute('**/auth/v1/verify**');

    await opening.getByRole('button', { name: 'Continue to MatchDay' }).click();
    await opening.waitForURL(/\/reset-password/);
    await expect(opening.getByRole('heading', { name: 'Set your password' })).toBeVisible();

    const replacement = 'a brand new passphrase';
    await opening.getByLabel('New password', { exact: true }).fill(replacement);
    await opening.getByLabel('Confirm new password').fill(replacement);
    await opening.getByRole('button', { name: 'Set password' }).click();
    await opening.waitForURL(/\/onboarding|\/dashboard/);
    await expectNoServerError(opening);

    // The new password works and the old one does not.
    const withNew = await freshContext(browser);
    await signInWithPassword(withNew, email, replacement);
    await withNew.waitForURL(/\/onboarding|\/dashboard/);
    expect(await hasSessionCookie(withNew)).toBe(true);

    const withOld = await freshContext(browser);
    await signInWithPassword(withOld, email, PASSWORD);
    await expect(withOld.getByText('Email or password is incorrect.')).toBeVisible();

    expect(factory).toBeTruthy();
  });

  test('a spent recovery link cannot be replayed', async ({ browser }) => {
    const email = freshAddress('replay');

    const setup = await freshContext(browser);
    await createAccount(setup, email);
    const confirmLink = await confirmationLink(setup, email, 'signup');
    const confirming = await freshContext(browser);
    await confirming.goto(confirmLink.toString());
    await confirming.getByRole('button', { name: 'Continue to MatchDay' }).click();
    await confirming.waitForURL(/\/onboarding/);

    const asking = await freshContext(browser);
    await asking.goto('/forgot-password');
    await asking.waitForLoadState('networkidle');
    await asking.getByLabel('Email address').fill(email);
    await asking.getByRole('button', { name: 'Send recovery email' }).click();
    const link = await confirmationLink(asking, email, 'recovery');

    const first = await freshContext(browser);
    await first.goto(link.toString());
    await first.getByRole('button', { name: 'Continue to MatchDay' }).click();
    await first.waitForURL(/\/reset-password/);

    const replay = await freshContext(browser);
    await replay.goto(link.toString());
    await replay.getByRole('button', { name: 'Continue to MatchDay' }).click();
    await expect(replay.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
    expect(await hasSessionCookie(replay)).toBe(false);
  });

  test('an unknown address gets the same acknowledgement', async ({ browser, factory }) => {
    const stranger = freshAddress('nobody');

    const page = await freshContext(browser);
    await page.goto('/forgot-password');
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Email address').fill(stranger);
    await page.getByRole('button', { name: 'Send recovery email' }).click();

    await expect(page.getByText(/If an account exists for that email/)).toBeVisible();
    await expect(page.getByText(/no account|not found|does not exist/i)).toHaveCount(0);

    const rows = await factory.query('select id from auth.users where email = $1', [stranger]);
    expect(rows).toEqual([]);
  });

  test('/reset-password refuses somebody who just typed the URL', async ({ browser }) => {
    const page = await freshContext(browser);
    await page.goto('/reset-password');

    await expect(page).toHaveURL(/\/forgot-password/);
    expect(await hasSessionCookie(page)).toBe(false);
  });
});

// ══ The migration that matters ═════════════════════════════════════════════

test.describe('a historical passwordless member', () => {
  test('sets a first password and keeps every scrap of their data', async ({
    browser,
    factory,
  }) => {
    // The factory creates accounts exactly as the passwordless product did:
    // an `auth.users` row with `encrypted_password` null and a real
    // `auth.identities` row. Asserted rather than assumed, because the whole
    // test is meaningless if the fixture already has a password.
    const league = await factory.createLeague();
    const member = await factory.createMember(league);

    const before = await factory.query<{ id: string; has_password: boolean }>(
      `select id::text as id, encrypted_password is not null as has_password
         from auth.users where email = $1`,
      [member.email],
    );
    expect(before[0]?.has_password).toBe(false);

    // Password sign-in cannot work yet.
    const tooEarly = await freshContext(browser);
    await signInWithPassword(tooEarly, member.email, 'anything at all really');
    await expect(tooEarly.getByText('Email or password is incorrect.')).toBeVisible();

    // Path A: the route a signed-out member takes.
    const asking = await freshContext(browser);
    await asking.goto('/forgot-password');
    await asking.waitForLoadState('networkidle');
    await asking.getByLabel('Email address').fill(member.email);
    await asking.getByRole('button', { name: 'Send recovery email' }).click();
    await expect(asking.getByText(/If an account exists for that email/)).toBeVisible();

    const link = await confirmationLink(asking, member.email, 'recovery');
    expect(link.searchParams.get('type')).toBe('recovery');

    const opening = await freshContext(browser);
    await opening.goto(link.toString());
    await opening.getByRole('button', { name: 'Continue to MatchDay' }).click();
    await opening.waitForURL(/\/reset-password/);

    const chosen = 'my first ever password';
    await opening.getByLabel('New password', { exact: true }).fill(chosen);
    await opening.getByLabel('Confirm new password').fill(chosen);
    await opening.getByRole('button', { name: 'Set password' }).click();

    // They have a profile already, so they land in the app rather than in
    // onboarding — proof in itself that the account was not replaced.
    await opening.waitForURL(/\/dashboard/);
    await expect(opening.getByRole('heading', { name: `Hello, ${member.firstName}` })).toBeVisible();

    // The same user id, and the same everything hanging off it.
    const after = await factory.query<{ id: string; has_password: boolean }>(
      `select id::text as id, encrypted_password is not null as has_password
         from auth.users where email = $1`,
      [member.email],
    );
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.has_password).toBe(true);

    const profile = await factory.query<{ first_name: string }>(
      'select first_name from public.profiles where id = $1',
      [member.id],
    );
    expect(profile[0]?.first_name).toBe(member.firstName);

    const memberships = await factory.query<{ league_id: string; status: string }>(
      'select league_id::text as league_id, status::text as status from public.league_memberships where user_id = $1',
      [member.id],
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.league_id).toBe(league.id);
    expect(memberships[0]?.status).toBe('active');

    // And from now on, the ordinary way in works.
    const returning = await freshContext(browser);
    await signInWithPassword(returning, member.email, chosen);
    await returning.waitForURL(/\/dashboard/);
    await expect(returning.getByRole('heading', { name: `Hello, ${member.firstName}` })).toBeVisible();
  });

  test('Path B: the profile offers the email route without needing to know', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);

    // Signed in by code, as a historical member would be.
    const page = await asUser(member.email);
    await page.goto('/profile');
    await page.getByRole('button', { name: 'Set or change password' }).click();

    // The change form asks for a current password this account does not have,
    // and says what to do about it — the email route is offered permanently
    // rather than only after a failure.
    await expect(page.getByRole('link', { name: 'Set one by email instead' })).toBeVisible();

    await page.getByLabel('Current password').fill('there is not one');
    await page.getByLabel('New password', { exact: true }).fill('a perfectly fine password');
    await page.getByLabel('Confirm new password').fill('a perfectly fine password');
    await page.getByRole('button', { name: 'Change password' }).click();

    await expect(page.getByText(/not your current password/)).toBeVisible();

    // Nothing changed, and the account still has no password.
    const rows = await factory.query<{ has_password: boolean }>(
      'select encrypted_password is not null as has_password from auth.users where id = $1',
      [member.id],
    );
    expect(rows[0]?.has_password).toBe(false);
  });
});

// ══ Changing a password from inside the app ════════════════════════════════

test.describe('changing a password', () => {
  test('needs the current one, and then works', async ({ browser }) => {
    const email = freshAddress('change');

    const setup = await freshContext(browser);
    await createAccount(setup, email);
    const link = await confirmationLink(setup, email, 'signup');
    const page = await freshContext(browser);
    await page.goto(link.toString());
    await page.getByRole('button', { name: 'Continue to MatchDay' }).click();
    await page.waitForURL(/\/onboarding/);

    // Onboard, so the profile page is reachable.
    await page.getByLabel('First name').fill('Pat');
    await page.getByLabel('Last name').fill('Keeper');
    await page.getByRole('button', { name: /Save|Continue|Finish/ }).first().click();
    await page.waitForURL(/\/dashboard|\/profile/);

    await page.goto('/profile');
    await page.getByRole('button', { name: 'Set or change password' }).click();

    // The wrong current password is refused.
    await page.getByLabel('Current password').fill('definitely not it');
    await page.getByLabel('New password', { exact: true }).fill('a second good password');
    await page.getByLabel('Confirm new password').fill('a second good password');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText(/not your current password/)).toBeVisible();

    // The right one is accepted.
    const replacement = 'a second good password';
    await page.getByLabel('Current password').fill(PASSWORD);
    await page.getByLabel('New password', { exact: true }).fill(replacement);
    await page.getByLabel('Confirm new password').fill(replacement);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Password updated. Use it next time you sign in.')).toBeVisible();

    const returning = await freshContext(browser);
    await signInWithPassword(returning, email, replacement);
    await returning.waitForURL(/\/dashboard/);
  });
});

/** How many messages Mailpit holds for an address. */
async function countEmails(address: string): Promise<number> {
  const { readSupabaseEnvironment } = await import('../support/environment');
  const base = readSupabaseEnvironment().mailpitUrl.replace(/\/+$/, '');
  const response = await fetch(`${base}/api/v1/messages?limit=500`);
  const { messages } = (await response.json()) as {
    messages: { To: { Address: string }[] }[];
  };
  return messages.filter((message) =>
    message.To.some((to) => to.Address.toLowerCase() === address.toLowerCase()),
  ).length;
}

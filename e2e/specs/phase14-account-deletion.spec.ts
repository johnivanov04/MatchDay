import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, expectNoServerError, test } from '../support/fixtures';
import type { TestDataFactory, TestUser } from '../support/factory';
import { waitForEmail } from '../support/mailbox';

/**
 * Deleting your MatchDay account.
 *
 * ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────
 *
 * Apple requires an app that creates accounts to let somebody delete theirs
 * from inside the app — not by emailing support. So the assertions here are
 * about the whole journey being completable in a browser, and about the two
 * properties that pull against each other once it is:
 *
 *   * nothing personal survives;
 *   * the completed match still has the same number of players on it.
 *
 * The database suite proves both at the row level. What only a browser can
 * prove is that somebody can get there, that an administrator is never shown an
 * instruction they cannot follow, and that a half-finished deletion leaves the
 * product genuinely unusable rather than merely awkward.
 */

const PHONE = { width: 390, height: 844 };

test.use({ viewport: PHONE });

async function openDeleteDialog(page: Page) {
  await page.goto('/profile');
  await page.waitForLoadState('networkidle');
  await expect(async () => {
    await page.getByRole('button', { name: /Delete account/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

/** The emailed re-authentication code. */
function codeFrom(body: string): string {
  const match = /\b(\d{6,10})\b/.exec(body);
  if (match === null) {
    throw new Error('The re-authentication email carried no one-time code.');
  }
  return match[1]!;
}

/**
 * Deletes the signed-in account through the interface, proving identity with an
 * emailed code.
 *
 * The factory mints accounts with no password — which is the realistic shape
 * for MatchDay's secondary sign-in method, and the case that must not be told
 * to type a password it never set.
 */
async function deleteViaCode(page: Page, email: string) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /email me a code/i }).click();
  await dialog.getByRole('button', { name: 'Send me a code' }).click();
  await expect(dialog.getByText('Code sent. Check your email.')).toBeVisible();

  const emailed = await waitForEmail(email);
  await dialog.getByLabel('Code from your email').fill(codeFrom(emailed.html));
  await dialog.getByRole('button', { name: 'Delete my account' }).click();

  await page.waitForURL(/\/account\/deleted/);
}

async function profileRow(factory: TestDataFactory, userId: string) {
  const rows = await factory.query<{
    first_name: string;
    last_name: string;
    email_normalized: string;
    phone: string | null;
    profile_photo_path: string | null;
    deleted: boolean;
  }>(
    `select first_name, last_name, email_normalized, phone, profile_photo_path,
            deleted_at is not null as deleted
       from public.profiles where id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

// ══════════════════════════════════════════════════════════════════════════
// The ordinary player.
// ══════════════════════════════════════════════════════════════════════════

test.describe('a player deleting their account', () => {
  test('warns, re-authenticates, deletes, signs out, and cannot sign back in', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague({ visibility: 'searchable' });
    const player = await factory.createMember(league);
    const match = await factory.createMatch(league, { kickoffInHours: 72 });
    await factory.joinMatch(match, player);

    const page = await asUser(player.email);
    await openDeleteDialog(page);

    // ── What it says before anything happens ──────────────────────────────
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('permanent and cannot be undone');
    await expect(dialog).toContainText('taken out of your leagues');
    // The reassurance that stops somebody believing they are erasing the
    // league's record of matches they played in.
    await expect(dialog).toContainText('without your name');

    // ── Cancel changes nothing ────────────────────────────────────────────
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect((await profileRow(factory, player.id))!.first_name).toBe(player.firstName);

    // ── Do it ─────────────────────────────────────────────────────────────
    await openDeleteDialog(page);
    await deleteViaCode(page, player.email);

    await expect(page.getByRole('heading', { name: /account was deleted|Almost finished/ })).toBeVisible();
    await expectNoServerError(page);

    // ── The account is gone from Auth ─────────────────────────────────────
    await expect
      .poll(async () => {
        const rows = await factory.query<{ n: string }>(
          'select count(*)::text as n from auth.users where id = $1',
          [player.id],
        );
        return rows[0]!.n;
      })
      .toBe('0');

    // ── And the profile is a tombstone holding nothing personal ───────────
    const tombstone = (await profileRow(factory, player.id))!;
    expect(tombstone.first_name).toBe('Former');
    expect(tombstone.last_name).toBe('member');
    expect(tombstone.email_normalized).toBe(`deleted-${player.id}@deleted.invalid`);
    expect(tombstone.phone).toBeNull();
    expect(tombstone.profile_photo_path).toBeNull();
    expect(tombstone.deleted).toBe(true);

    // ── The session is dead everywhere ────────────────────────────────────
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/sign-in|\/account\/deleted/);

    // ── And the upcoming match released their place ───────────────────────
    const signups = await factory.query<{ status: string }>(
      `select s.status::text from public.match_signups s
         join public.league_memberships m on m.id = s.membership_id
        where s.match_id = $1 and m.user_id = $2`,
      [match.id, player.id],
    );
    expect(signups[0]!.status).toBe('not_selected');
  });

  test('frees the email address for a brand-new account', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    const page = await asUser(player.email);
    await openDeleteDialog(page);
    await deleteViaCode(page, player.email);

    await expect
      .poll(async () => {
        const rows = await factory.query<{ n: string }>(
          'select count(*)::text as n from auth.users where id = $1',
          [player.id],
        );
        return rows[0]!.n;
      })
      .toBe('0');

    // A new signup with the same address is a new identity: new auth uuid, new
    // profile id, and nothing reconnected to the old one.
    await page.goto('/sign-up');
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Email address').fill(player.email);
    await page.getByLabel('Password', { exact: true }).fill('a-brand-new-passphrase');
    await page.getByLabel('Confirm password').fill('a-brand-new-passphrase');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    await expect
      .poll(async () => {
        const rows = await factory.query<{ n: string }>(
          'select count(*)::text as n from auth.users where email = $1',
          [player.email],
        );
        return rows[0]!.n;
      })
      .toBe('1');

    const rows = await factory.query<{ id: string }>(
      'select id from auth.users where email = $1',
      [player.email],
    );
    expect(rows[0]!.id).not.toBe(player.id);

    // No history followed them.
    const memberships = await factory.query<{ n: string }>(
      'select count(*)::text as n from public.league_memberships where user_id = $1',
      [rows[0]!.id],
    );
    expect(memberships[0]!.n).toBe('0');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// What everybody else sees afterwards.
// ══════════════════════════════════════════════════════════════════════════

test.describe('the rest of the league', () => {
  test('keeps the completed match whole, with the player shown as Former member', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const leaving = await factory.createMember(league);
    const staying = await factory.createMember(league);
    const match = await factory.createMatch(league, { kickoffInHours: 48 });
    await factory.joinMatch(match, leaving);
    await factory.joinMatch(match, staying);
    await factory.endMatch(match, 2);

    const before = await factory.query<{ n: string }>(
      'select count(*)::text as n from public.match_signups where match_id = $1',
      [match.id],
    );

    const leavingPage = await asUser(leaving.email);
    await openDeleteDialog(leavingPage);
    await deleteViaCode(leavingPage, leaving.email);

    // THE PROPERTY THE WHOLE TOMBSTONE ARCHITECTURE EXISTS FOR. Under the old
    // cascade this row disappeared and the match silently shrank.
    const after = await factory.query<{ n: string }>(
      'select count(*)::text as n from public.match_signups where match_id = $1',
      [match.id],
    );
    expect(after[0]!.n).toBe(before[0]!.n);

    // The register for a match that was played still lists everybody who
    // played, and names the departed one neutrally.
    const adminPage = await asUser(league.admin.email);
    await adminPage.goto(`/leagues/${league.slug}/matches/${match.id}/attendance`);
    await adminPage.waitForLoadState('networkidle');

    await expect(adminPage.getByText('Former member').first()).toBeVisible();
    await expect(adminPage.getByText(staying.firstName).first()).toBeVisible();
    await expect(adminPage.getByText(leaving.firstName)).toHaveCount(0);
    await expect(adminPage.locator('body')).not.toContainText(leaving.email);
    // The synthetic address is a schema necessity, never a thing to render.
    await expect(adminPage.locator('body')).not.toContainText('@deleted.invalid');
    await expectNoServerError(adminPage);
  });

  test('shows nothing of them on the members list either', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const leaving = await factory.createMember(league);

    const leavingPage = await asUser(leaving.email);
    await openDeleteDialog(leavingPage);
    await deleteViaCode(leavingPage, leaving.email);

    const adminPage = await asUser(league.admin.email);
    await adminPage.goto(`/leagues/${league.slug}/members`);
    await adminPage.waitForLoadState('networkidle');

    // A departed member's membership is `removed`, and this screen already
    // keeps those off the list behind a count — so the assertion is about what
    // is absent rather than about a "Former member" row.
    await expect(adminPage.getByText(leaving.firstName)).toHaveCount(0);
    await expect(adminPage.locator('body')).not.toContainText(leaving.email);
    await expect(adminPage.locator('body')).not.toContainText('@deleted.invalid');
    await expectNoServerError(adminPage);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Administrators.
// ══════════════════════════════════════════════════════════════════════════

test.describe('an administrator deleting their account', () => {
  test('is blocked, transfers, and then deletes', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const successor = await factory.createMember(league);

    const page = await asUser(league.admin.email);
    await openDeleteDialog(page);

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Deal with your league first');
    await expect(dialog.getByText(league.name)).toBeVisible();

    await dialog.getByRole('button', { name: 'Transfer administration' }).click();
    await expect(page).toHaveURL(new RegExp(`/leagues/${league.slug}/members`));

    await page.getByLabel('New administrator').selectOption(successor.membershipId);
    await page.getByLabel('Type “transfer” to confirm').fill('transfer');
    await page.getByRole('button', { name: /transfer administration/i }).click();
    await page.waitForURL(/\/dashboard/);

    // Now an ordinary player, so the confirmation is offered instead.
    await openDeleteDialog(page);
    await expect(page.getByRole('dialog')).toContainText('permanent and cannot be undone');
    await deleteViaCode(page, league.admin.email);

    const admins = await factory.query<{ user_id: string }>(
      `select user_id from public.league_memberships
        where league_id = $1 and role = 'league_admin' and status = 'active'`,
      [league.id],
    );
    expect(admins).toHaveLength(1);
    expect(admins[0]!.user_id).toBe(successor.id);
  });

  test('can close the league instead, and the members are told', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const match = await factory.createMatch(league, { kickoffInHours: 72 });
    await factory.joinMatch(match, member);

    const page = await asUser(league.admin.email);
    await openDeleteDialog(page);

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Close league' }).click();
    await dialog.getByLabel('Type “close” to confirm').fill('close');
    await dialog.getByRole('button', { name: 'Close league' }).click();

    await expect
      .poll(async () => {
        const rows = await factory.query<{ closed: boolean }>(
          'select closed_at is not null as closed from public.leagues where id = $1',
          [league.id],
        );
        return rows[0]!.closed;
      })
      .toBe(true);

    // The future match is off, through the canonical cancellation.
    const matches = await factory.query<{ status: string }>(
      'select status::text from public.matches where id = $1',
      [match.id],
    );
    expect(matches[0]!.status).toBe('canceled');

    // And the remaining member has been told, once, in the app.
    const notifications = await factory.query<{ n: string }>(
      `select count(*)::text as n from public.notifications
        where type = 'league_closed' and recipient_user_id = $1`,
      [member.id],
    );
    expect(notifications[0]!.n).toBe('1');

    const memberPage = await asUser(member.email);
    await memberPage.goto('/notifications');
    await expect(memberPage.getByText('League closed')).toBeVisible();

    // With nothing blocking it, the deletion now goes through.
    await page.reload();
    await openDeleteDialog(page);
    await deleteViaCode(page, league.admin.email);

    const tombstone = (await profileRow(factory, league.admin.id))!;
    expect(tombstone.first_name).toBe('Former');
  });

  test('with nobody to transfer to is never shown an impossible instruction', async ({
    factory,
    asUser,
  }) => {
    // THE DEAD END THIS FEATURE EXISTS TO REMOVE. A league of one has no
    // eligible successor, so "transfer administration first" would be advice
    // this person cannot act on.
    const league = await factory.createLeague();

    const page = await asUser(league.admin.email);
    await openDeleteDialog(page);

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Transfer administration' })).toHaveCount(0);
    await expect(dialog).toContainText('no one to transfer it to');

    // The real self-service path.
    await dialog.getByRole('button', { name: 'Close league' }).click();
    await dialog.getByLabel('Type “close” to confirm').fill('close');
    await dialog.getByRole('button', { name: 'Close league' }).click();

    await expect
      .poll(async () => {
        const rows = await factory.query<{ closed: boolean }>(
          'select closed_at is not null as closed from public.leagues where id = $1',
          [league.id],
        );
        return rows[0]!.closed;
      })
      .toBe(true);

    await page.reload();
    await openDeleteDialog(page);
    await deleteViaCode(page, league.admin.email);

    expect((await profileRow(factory, league.admin.id))!.deleted).toBe(true);

    // The league survives, closed, with its history and zero administrators.
    const leagues = await factory.query<{ n: string }>(
      'select count(*)::text as n from public.leagues where id = $1',
      [league.id],
    );
    expect(leagues[0]!.n).toBe('1');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// A deletion that stopped part-way.
// ══════════════════════════════════════════════════════════════════════════

test.describe('a deletion-pending session', () => {
  /** Starts a deletion in the database without finishing it, as a failure would. */
  async function beginOnly(factory: TestDataFactory, user: TestUser) {
    await factory.query(
      `update public.profiles set deletion_started_at = now() where id = $1`,
      [user.id],
    );
  }

  test('can reach only the deletion-status screen', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    const page = await asUser(player.email);
    await beginOnly(factory, player);

    // Every ordinary route lands on the terminal screen instead.
    for (const route of ['/dashboard', '/profile', '/notifications', `/leagues/${league.slug}/matches`]) {
      await page.goto(route);
      await expect(page, `${route} did not route to the deletion status`).toHaveURL(
        /\/account\/deleted/,
      );
    }

    await expectNoServerError(page);

    // Not onboarding — the trap that a liveness-gated profile SELECT would have
    // created, inviting somebody to recreate the profile they are deleting.
    await expect(page.getByRole('heading', { name: /Set up your profile/ })).toHaveCount(0);

    // No app navigation at all.
    await expect(page.getByRole('link', { name: 'Matches' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Inbox' })).toHaveCount(0);
  });

  test('can finish the deletion from that screen', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    const page = await asUser(player.email);
    await beginOnly(factory, player);

    await page.goto('/account/deleted');
    await expect(page.getByRole('heading', { name: /Finishing your account deletion/ })).toBeVisible();

    await page.getByRole('button', { name: /Finish deleting account/ }).click();
    await page.waitForURL(/\/account\/deleted/);

    await expect
      .poll(async () => (await profileRow(factory, player.id))!.deleted)
      .toBe(true);
    await expect
      .poll(async () => {
        const rows = await factory.query<{ n: string }>(
          'select count(*)::text as n from auth.users where id = $1',
          [player.id],
        );
        return rows[0]!.n;
      })
      .toBe('0');
  });

  test('is told the truth when only the Auth half is outstanding', async ({ factory, asUser }) => {
    // The state that looks finished and is not: MatchDay is anonymous while
    // auth.users still holds the real address.
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    const page = await asUser(player.email);
    await factory.query(
      `update public.profiles
          set deletion_started_at = now(), deleted_at = now(),
              first_name = 'Former', last_name = 'member',
              email_normalized = 'deleted-' || id || '@deleted.invalid',
              phone = null, gender = null, preferred_positions = '{}',
              goalkeeper_willing = null, profile_photo_url = null, profile_photo_path = null
        where id = $1`,
      [player.id],
    );

    await page.goto('/account/deleted');
    await expect(page.getByRole('heading', { name: /Almost finished/ })).toBeVisible();
    await expect(page.locator('body')).toContainText('not finished being deleted');

    await page.getByRole('button', { name: /Finish deleting account/ }).click();

    await expect
      .poll(async () => {
        const rows = await factory.query<{ n: string }>(
          'select count(*)::text as n from auth.users where id = $1',
          [player.id],
        );
        return rows[0]!.n;
      })
      .toBe('0');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Mobile and accessibility.
// ══════════════════════════════════════════════════════════════════════════

test.describe('the confirmation on a phone', () => {
  async function expectNoHorizontalScroll(page: Page, label: string) {
    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow, `${label} scrolls the page sideways`).toBeLessThanOrEqual(1);
  }

  test('fits 320px, keeps the destructive controls a fingertip tall, and passes axe', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    const page = await asUser(player.email);
    await page.setViewportSize({ width: 320, height: 568 });
    await openDeleteDialog(page);

    await expectNoHorizontalScroll(page, 'the delete-account confirmation at 320px');

    for (const name of ['Cancel', 'Delete my account']) {
      const box = await page.getByRole('dialog').getByRole('button', { name }).boundingBox();
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

  test('holds up in dark mode with a very long league name', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    await factory.query('update public.leagues set name = $2 where id = $1', [
      league.id,
      'Thursday Night Five-a-Side and Occasional Seven-a-Side Football Club',
    ]);

    const page = await asUser(league.admin.email);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 320, height: 568 });
    await openDeleteDialog(page);

    await expectNoHorizontalScroll(page, 'the blocked administrator screen at 320px in dark mode');

    const results = await new AxeBuilder({ page }).withTags(['wcag2aa']).analyze();
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  test('cannot be triggered by a single tap', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    const page = await asUser(player.email);
    await openDeleteDialog(page);

    // The row opened a confirmation and nothing else. Proof of identity is
    // still required before anything irreversible happens.
    await expect(page.getByRole('dialog').getByLabel('Confirm your password')).toBeVisible();
    expect((await profileRow(factory, player.id))!.first_name).toBe(player.firstName);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    expect((await profileRow(factory, player.id))!.first_name).toBe(player.firstName);
  });
});

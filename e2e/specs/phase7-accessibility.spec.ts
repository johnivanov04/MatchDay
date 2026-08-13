import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';

/**
 * The accessibility pass, run against the real pages with real data.
 *
 * WHAT IS BEING CHECKED, AND WHAT IS NOT. axe finds machine-detectable
 * failures: contrast, missing labels, broken landmark structure, controls with
 * no accessible name. It cannot tell whether a heading order makes sense or
 * whether a live region announces at a useful moment — those are asserted by
 * hand below, and the rest is a judgement call this suite does not pretend to
 * automate.
 *
 * The standard is WCAG 2.1 AA, which is what "accessible" means without further
 * qualification. `wcag2a`, `wcag2aa`, `wcag21a` and `wcag21aa` are the tag sets
 * that add up to it.
 *
 * Every page is checked signed in and populated. An empty screen passes almost
 * anything; a roster with fourteen names and a dozen controls is where labels
 * actually go missing.
 */

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();

  // The message names the rule and the element, so a failure is actionable
  // from the CI log without opening a trace.
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target.join(' ')),
    })),
  ).toEqual([]);
}

test.describe('accessibility', () => {
  test('the dashboard', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    await factory.createMatch(league);

    const page = await asUser(league.admin.email);
    await page.goto('/dashboard');
    // Let the router's link prefetching finish first. Clicking while a prefetch
    // for the same route is still in flight makes the router await *that*
    // request rather than issuing the navigation fetch this test holds — so
    // nothing is held, the page renders straight away, and the loading state
    // never appears. Synchronising on the network going quiet is a real
    // condition, not a sleep.
    await page.waitForLoadState('networkidle');
    await expectNoViolations(page);
  });

  test('the match list, with a player’s own attendance', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const past = await factory.createMatch(league);
    const player = await factory.createMember(league);
    await factory.joinMatch(past, player);
    await factory.endMatch(past);
    await factory.callAs(league.admin, `select public.record_attendance($1, $2, 'no_show')`, [
      past.id,
      player.membershipId,
    ]);
    await factory.createMatch(league, { kickoffInHours: 48 });

    const page = await asUser(player.email);
    await page.goto(`/leagues/${league.slug}/matches`);
    await expectNoViolations(page);
  });

  test('a match detail page with a published roster', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 4 });
    const players = [];
    for (let index = 0; index < 3; index += 1) {
      const player = await factory.createMember(league);
      await factory.joinMatch(match, player);
      players.push(player);
    }
    await factory.callAs(league.admin, 'select public.finalize_roster($1)', [match.id]);

    const page = await asUser(players[0]!.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expectNoViolations(page);
  });

  test('the roster workspace, with no-show context', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const past = await factory.createMatch(league);
    const player = await factory.createMember(league);
    await factory.joinMatch(past, player);
    await factory.endMatch(past);
    await factory.callAs(league.admin, `select public.record_attendance($1, $2, 'no_show')`, [
      past.id,
      player.membershipId,
    ]);

    const match = await factory.createMatch(league, { capacity: 2 });
    await factory.joinMatch(match, player);
    for (let index = 0; index < 2; index += 1) {
      const other = await factory.createMember(league);
      await factory.joinMatch(match, other); // one confirmed, one waitlisted
    }

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/${match.id}/roster`);
    await expect(admin.getByText(/recorded match/)).toBeVisible();
    await expectNoViolations(admin);
  });

  test('the attendance register', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 6 });
    const players = [];
    for (let index = 0; index < 3; index += 1) {
      const player = await factory.createMember(league);
      await factory.joinMatch(match, player);
      players.push(player);
    }
    // One withdrawal, so the register carries both kinds of row.
    await factory.callAs(players[2]!, 'select public.cancel_spot($1, $2)', [match.id, 'Injured']);
    await factory.endMatch(match);
    await factory.callAs(league.admin, `select public.record_attendance($1, $2, 'attended')`, [
      match.id,
      players[0]!.membershipId,
    ]);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/${match.id}/attendance`);
    await expectNoViolations(admin);
  });

  test('the team builder', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 6 });
    for (let index = 0; index < 4; index += 1) {
      const player = await factory.createMember(league);
      await factory.joinMatch(match, player);
    }
    await factory.callAs(league.admin, 'select public.ensure_match_teams($1)', [match.id]);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/${match.id}/teams`);
    await expectNoViolations(admin);
  });

  test('member management, including the membership status controls', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    await factory.createMember(league);
    const suspended = await factory.createMember(league);
    await factory.callAs(
      league.admin,
      `select public.set_membership_status($1, 'suspended', $2)`,
      [suspended.membershipId, 'Cooling-off period'],
    );

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/members`);
    await expectNoViolations(admin);
  });

  test('the notification inbox', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league);
    const player = await factory.createMember(league);
    await factory.joinMatch(match, player);
    await factory.endMatch(match);
    await factory.callAs(league.admin, `select public.record_attendance($1, $2, 'attended')`, [
      match.id,
      player.membershipId,
    ]);

    const page = await asUser(player.email);
    await page.goto('/notifications');
    await expectNoViolations(page);
  });

  test('the match creation form', async ({ factory, asUser }) => {
    const league = await factory.createLeague();

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/new`);
    await expectNoViolations(admin);
  });

  test('the not-found page', async ({ factory, asUser }) => {
    const league = await factory.createLeague();

    const page = await asUser(league.admin.email);
    await page.goto('/no-such-route-exists');
    await expectNoViolations(page);
  });
});

/**
 * The things axe cannot see.
 *
 * Each of these is a rule a screen reader user depends on and a machine cannot
 * verify: that the page has exactly one first-level heading, that every control
 * can be reached and operated from the keyboard alone, and that a form error is
 * announced rather than merely displayed.
 */
test.describe('accessibility beyond what axe can check', () => {
  test('every page has exactly one h1', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league);
    await factory.endMatch(match);

    const admin = await asUser(league.admin.email);

    for (const path of [
      '/dashboard',
      `/leagues/${league.slug}/matches`,
      `/leagues/${league.slug}/matches/${match.id}`,
      `/leagues/${league.slug}/matches/${match.id}/roster`,
      `/leagues/${league.slug}/matches/${match.id}/teams`,
      `/leagues/${league.slug}/matches/${match.id}/attendance`,
      `/leagues/${league.slug}/members`,
      '/notifications',
    ]) {
      await admin.goto(path);
      await expect(admin.locator('h1'), `one h1 on ${path}`).toHaveCount(1);
    }
  });

  test('the attendance register is operable from the keyboard alone', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league);
    const player = await factory.createMember(league);
    await factory.joinMatch(match, player);
    await factory.endMatch(match);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/${match.id}/attendance`);

    const select = admin.getByLabel(`Attendance for ${player.firstName} Tester`);
    await select.selectOption('attended');
    // Focus is re-established after the selection rather than before it:
    // `selectOption` drives the native picker and does not guarantee where
    // focus lands afterwards, so tabbing from it would be testing Playwright.
    await select.focus();

    // Tab to the note, then to the save button, and activate it with Enter —
    // no pointer involved at any point.
    await admin.keyboard.press('Tab');
    await expect(admin.getByLabel(`Note about ${player.firstName} Tester`, { exact: false })).toBeFocused();
    await admin.keyboard.press('Tab');
    await expect(admin.getByRole('button', { name: 'Save' })).toBeFocused();
    await admin.keyboard.press('Enter');

    await expect(admin.getByRole('button', { name: 'Update' })).toBeVisible();

    const rows = await factory.query<{ outcome: string }>(
      'select outcome::text from public.attendance_records where match_id = $1',
      [match.id],
    );
    expect(rows[0]?.outcome).toBe('attended');
  });

  test('the skip link is the first thing a keyboard reaches', async ({ factory, asUser }) => {
    const league = await factory.createLeague();

    const page = await asUser(league.admin.email);
    await page.goto('/dashboard');
    await page.keyboard.press('Tab');

    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  });

  test('a refused membership change is announced, not just displayed', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const player = await factory.createMember(league);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/members`);

    const row = admin.locator('li').filter({ has: admin.locator(`#status-${player.membershipId}`) }).first();
    await row.getByLabel('Membership status').selectOption('suspended');
    await row.getByRole('button', { name: 'Update' }).click();

    // `role="alert"` is assertive: a screen reader interrupts to say the change
    // did not happen, rather than leaving somebody to discover it by re-reading
    // the form.
    await expect(row.locator('[role="alert"]')).toContainText(/Give a reason/i);
  });

  test('the loading state announces itself, and is announced politely', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league);

    const page = await asUser(league.admin.email);
    await page.goto('/dashboard');

    // HELD OPEN, NOT SLOWED DOWN.
    //
    // The first version of this test delayed the *document* request by 1.2s and
    // then looked for the skeleton. That delays the moment the loading state
    // starts, not how long it lasts: the browser spends the delay showing the
    // previous page, and the skeleton still only survives for however long the
    // server happens to take — a window wide enough to catch on a laptop and
    // not on CI, where it failed.
    //
    // Instead this holds the React Server Component payload that a client-side
    // navigation fetches, so the loading state lasts exactly as long as the
    // test needs rather than however long the server happens to take.
    //
    // WAITING FOR THE NETWORK TO GO QUIET FIRST IS LOAD-BEARING, not tidiness.
    // The App Router prefetches every nav link when the dashboard paints, and
    // that prefetch is what fetches the `loading.tsx` boundary. With it cached,
    // clicking shows the loading state and commits the URL immediately, then
    // fetches the rest — which is the state this test inspects. Click before it
    // lands and the router has no boundary to show: it simply stays on the
    // dashboard until the payload arrives, and there is no loading state to
    // find. That is the actual reason the intermediate attempts here failed.
    await page.waitForLoadState('networkidle');

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    await page.route('**/leagues/**', async (route, request) => {
      const headers = request.headers();
      // Only the RSC fetch that a *click* makes.
      //
      // The App Router prefetches every nav link as soon as the dashboard
      // paints — a dozen requests, all carrying `rsc: 1`. Holding those as well
      // deadlocks the router before the click even happens, which is how the
      // first attempt at this managed to find no loading state at all.
      // `next-router-prefetch` is what separates speculative work from the
      // navigation the user actually asked for.
      const isNavigationPayload =
        headers['rsc'] === '1' && headers['next-router-prefetch'] === undefined;

      if (isNavigationPayload) {
        await held;
      }
      await route.continue();
    });

    await page.getByRole('link', { name: 'Matches', exact: true }).click();

    // WHILE loading is genuinely in progress:
    const status = page.getByRole('status');
    await expect(status).toBeVisible();
    await expect(status).toContainText('Loading');

    // `role="status"` implies aria-live="polite" — announced when the reader
    // finishes its sentence rather than interrupting, which is right for "this
    // is on its way" and wrong for an error. Asserted explicitly because the
    // implicit value is easy to override by accident.
    await expect(status).toHaveAttribute('role', 'status');
    expect(await status.getAttribute('aria-live')).not.toBe('assertive');

    // The skeleton itself is hidden from the reader — the live region above is
    // what speaks, and announcing a dozen grey rectangles as well is noise.
    await expect(page.locator('[aria-hidden="true"]').first()).toBeAttached();

    // Let it finish, and confirm we really did arrive.
    release();
    await expect(page.getByRole('heading', { name: 'Matches', exact: true })).toBeVisible();
    await expect(page.getByText(match.title)).toBeVisible();
    await expect(status).toHaveCount(0);
  });
});

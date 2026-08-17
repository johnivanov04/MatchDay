import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';

/**
 * The mobile pass.
 *
 * The pilot is a Sunday-league squad standing on a touchline, so "works on a
 * phone" is the product working at all rather than a nicety. These run at
 * 320×568 — an iPhone SE, the narrowest viewport still worth supporting —
 * because a layout that survives 320 survives everything above it, and every
 * horizontal-overflow bug shows up there first.
 *
 * WHAT IS ASSERTED. Three things a machine can genuinely check and a human
 * cannot check reliably by eye across twenty screens:
 *
 *   1. the page never scrolls sideways — the single most common mobile defect,
 *      and the one that makes an app feel broken rather than cramped;
 *   2. every interactive control is at least 44 CSS pixels tall, which is the
 *      WCAG 2.1 target-size guidance and roughly a fingertip;
 *   3. the primary action of each screen is reachable and operable.
 */

const PHONE = { width: 320, height: 568 };

test.use({ viewport: PHONE });

/**
 * Fails if the document is wider than the viewport.
 *
 * One pixel of tolerance for sub-pixel rounding in the layout engine; anything
 * beyond that is a real overflow somebody would feel as a page that drifts
 * sideways under their thumb.
 */
async function expectNoHorizontalScroll(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const limit = root.clientWidth;

    // Naming the culprits matters: "the page scrolls sideways" sends somebody
    // hunting through a whole screen, while "this <dd> containing
    // America/Los_Angeles reaches 347px" is a one-line fix.
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
    `${label} scrolls horizontally at ${String(PHONE.width)}px. Widest: ${
      overflow.culprits.join(' | ') || '(none individually over)'
    }`,
  ).toBeLessThanOrEqual(1);
}

/**
 * Fails if any control you tap to *do* something is too small to hit reliably.
 *
 * SCOPE. Buttons, selects, inputs and textareas — the controls that change
 * state, where a mis-tap costs somebody their spot in a match. Anchors are
 * excluded: they are navigation, a mis-tap is recoverable with the back button,
 * and WCAG's target-size guidance exempts links in a text flow. Holding every
 * inline link to 44px would mean padding out every sentence in the product,
 * which trades a real improvement for a cosmetic one.
 *
 * 44px is the figure from WCAG 2.1 SC 2.5.5 and both platform guidelines, and
 * is roughly the contact patch of an adult fingertip.
 */
async function expectTouchTargets(page: Page, label: string): Promise<void> {
  const small = await page.evaluate(() => {
    const results: string[] = [];
    const controls = document.querySelectorAll<HTMLElement>(
      'button, select, input:not([type="hidden"]), textarea',
    );

    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        continue; // not rendered
      }
      if (rect.height < 44) {
        results.push(
          `${control.tagName.toLowerCase()}#${control.id || '(no id)'} = ${String(
            Math.round(rect.height),
          )}px`,
        );
      }
    }
    return results;
  });

  expect(small, `${label} has controls under 44px tall`).toEqual([]);
}

async function expectUsableOnAPhone(page: Page, label: string): Promise<void> {
  await expectNoHorizontalScroll(page, label);
  await expectTouchTargets(page, label);
}

/**
 * Fails if a name is rendered by letting the row grow instead of truncating.
 *
 * Avatars made this worth asserting separately. A 32px circle plus a gap is
 * fixed width taken out of a 320px row, so any name container without
 * `min-w-0` + `truncate` beside one stops shrinking and pushes the row wider —
 * which `expectNoHorizontalScroll` would catch, but only after somebody works
 * out *why* the page drifts. This names the element instead.
 */
async function expectNamesTruncate(page: Page, label: string): Promise<void> {
  const overflowing = await page.evaluate(() => {
    const bad: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>('.truncate')) {
      // `scrollWidth > clientWidth` on a truncating element is normal and is
      // the ellipsis doing its job. What is not normal is the element being
      // wider than its own parent, which means it never shrank at all.
      const parent = element.parentElement;
      if (parent !== null && element.getBoundingClientRect().width > parent.clientWidth + 1) {
        bad.push(`"${(element.textContent ?? '').trim().slice(0, 30)}"`);
      }
    }
    return bad;
  });

  expect(overflowing, `${label} has a name that outgrew its container`).toEqual([]);
}

/**
 * A member with a real avatar and a name long enough to be a problem.
 *
 * The default fixture names are short and uniform, so without this the mobile
 * pass would test avatars beside names that could never have overflowed
 * anything.
 */
const LONG_FIRST = 'Bartholomew-Alexander';
const LONG_LAST = 'Featherstonehaugh-Wodehouse';

test.describe('on a 320px phone', () => {
  test('the attendance register', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 8 });
    const players = [];
    for (let index = 0; index < 4; index += 1) {
      const player = await factory.createMember(league);
      await factory.joinMatch(match, player);
      players.push(player);
    }
    // Real avatars, and one name long enough to fight the 32px circle for the
    // width of a 320px row. Half the players have none, so the mixed case —
    // circles and initials in one list — is what is measured.
    await factory.giveAvatar(players[0]!);
    await factory.giveAvatar(players[1]!);
    await factory.setName(players[1]!.id, LONG_FIRST, LONG_LAST);

    await factory.callAs(players[3]!, 'select public.cancel_spot($1, $2)', [match.id, 'Injured']);
    await factory.endMatch(match);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/${match.id}/attendance`);
    await expect(admin.getByRole('heading', { name: 'Attendance', exact: true })).toBeVisible();
    await expect(admin.locator('img')).not.toHaveCount(0);

    await expectUsableOnAPhone(admin, 'the attendance register');
    await expectNamesTruncate(admin, 'the attendance register');

    // And it actually works: an outcome recorded end to end at this width.
    const select = admin.getByLabel(`Attendance for ${players[0]!.firstName} Tester`);
    await select.selectOption('attended');
    await admin
      .locator('li')
      .filter({ has: select })
      .first()
      .getByRole('button', { name: 'Save' })
      .click();
    await expect(admin.getByRole('button', { name: 'Update' }).first()).toBeVisible();
  });

  test('the roster workspace with a full roster and a waitlist', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 4 });
    const players = [];
    for (let index = 0; index < 7; index += 1) {
      const player = await factory.createMember(league);
      await factory.joinMatch(match, player);
      players.push(player);
    }
    // Confirmed and waitlisted alike: the reorder rows carry two 44px buttons
    // next to a 24px circle, which is the tightest row in the workspace.
    await factory.giveAvatar(players[0]!);
    await factory.giveAvatar(players[5]!);
    await factory.setName(players[5]!.id, LONG_FIRST, LONG_LAST);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/${match.id}/roster`);
    await expect(admin.getByRole('heading', { name: 'Roster', exact: true })).toBeVisible();
    await expect(admin.locator('img')).not.toHaveCount(0);

    await expectUsableOnAPhone(admin, 'the roster workspace');
    await expectNamesTruncate(admin, 'the roster workspace');
  });

  test('the team builder', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 8 });
    const players = [];
    for (let index = 0; index < 6; index += 1) {
      const player = await factory.createMember(league);
      await factory.joinMatch(match, player);
      players.push(player);
    }
    await factory.giveAvatar(players[0]!);
    await factory.giveAvatar(players[1]!);
    await factory.setName(players[1]!.id, LONG_FIRST, LONG_LAST);
    await factory.callAs(league.admin, 'select public.ensure_match_teams($1)', [match.id]);
    // Assign somebody, so the dense 24px per-team list is on screen as well as
    // the 32px unassigned rows.
    await factory.callAs(league.admin, 'select public.randomize_match_teams($1)', [match.id]);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/${match.id}/teams`);
    await expect(admin.getByRole('heading', { name: 'Teams', exact: true })).toBeVisible();
    await expect(admin.locator('img')).not.toHaveCount(0);

    await expectUsableOnAPhone(admin, 'the team builder');
    await expectNamesTruncate(admin, 'the team builder');
  });

  test('member management with its status controls', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const members = [];
    for (let index = 0; index < 4; index += 1) {
      members.push(await factory.createMember(league));
    }
    // 36px here — the largest avatar in any list — beside a name *and* an email
    // address, which is the widest text block of any row in the product.
    await factory.giveAvatar(members[0]!);
    await factory.setName(members[0]!.id, LONG_FIRST, LONG_LAST);

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/members`);
    await expect(admin.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
    await expect(admin.locator('img')).not.toHaveCount(0);

    await expectUsableOnAPhone(admin, 'member management');
    await expectNamesTruncate(admin, 'member management');
  });

  test('the match detail page a player actually uses', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 8 });
    const players = [];
    for (let index = 0; index < 5; index += 1) {
      const player = await factory.createMember(league);
      await factory.joinMatch(match, player);
      players.push(player);
    }
    // The surface the audit flagged: these rows had no `min-w-0` before Phase 2,
    // so they are the ones most likely to drift sideways once a fixed-width
    // circle is put in front of the name. Both the confirmed roster and the
    // published team sheet are on this page.
    await factory.giveAvatar(players[0]!);
    await factory.giveAvatar(players[1]!);
    await factory.setName(players[1]!.id, LONG_FIRST, LONG_LAST);

    await factory.callAs(league.admin, 'select public.finalize_roster($1)', [match.id]);
    await factory.callAs(league.admin, 'select public.ensure_match_teams($1)', [match.id]);
    await factory.callAs(league.admin, 'select public.randomize_match_teams($1)', [match.id]);
    await factory.callAs(league.admin, 'select public.publish_match_teams($1)', [match.id]);

    const page = await asUser(players[0]!.email);
    await page.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(page.getByRole('heading', { name: match.title })).toBeVisible();
    // Two in the lists plus the header's own, so the assertions below are
    // measuring a page that actually has faces on it.
    await expect(page.locator('img')).not.toHaveCount(0);

    await expectUsableOnAPhone(page, 'the match detail page');
    await expectNamesTruncate(page, 'the match detail page');

    // The one action a player comes here for is present and hittable. The
    // touch-target sweep above already covers every control on the page; this
    // asserts the important one is actually on it.
    await expect(page.getByRole('button', { name: 'Cancel my spot' })).toBeVisible();
  });

  test('the match creation form, the longest form in the product', async ({ factory, asUser }) => {
    const league = await factory.createLeague();

    const admin = await asUser(league.admin.email);
    await admin.goto(`/leagues/${league.slug}/matches/new`);
    await expect(admin.getByRole('heading', { level: 1 })).toBeVisible();

    await expectUsableOnAPhone(admin, 'the match creation form');
  });

  test('the dashboard and the inbox', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league);
    const player = await factory.createMember(league);
    await factory.joinMatch(match, player);
    await factory.endMatch(match);
    await factory.callAs(league.admin, `select public.record_attendance($1, $2, 'no_show')`, [
      match.id,
      player.membershipId,
    ]);

    const page = await asUser(player.email);

    await page.goto('/dashboard');
    await expectUsableOnAPhone(page, 'the dashboard');

    await page.goto('/notifications');
    await expectUsableOnAPhone(page, 'the inbox');

    await page.goto(`/leagues/${league.slug}/matches`);
    await expectUsableOnAPhone(page, 'the match list');
  });
});

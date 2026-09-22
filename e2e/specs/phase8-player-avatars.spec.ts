import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, expectNoServerError, test } from '../support/fixtures';
import type { TestUser } from '../support/factory';

/**
 * Two real avatars, uploaded by two real people, appearing on each other's
 * screens.
 *
 * ── WHY THIS IS NOT SEEDED ─────────────────────────────────────────────────
 *
 * Writing `profile_photo_path` straight into the table would be quicker and
 * would prove almost nothing. The row would point at an object that does not
 * exist, every `<img>` would 404, `Avatar` would fall back to initials — and
 * the test would pass while asserting the *fallback*, which is the one outcome
 * it is supposed to distinguish from success.
 *
 * So both users go through the real upload flow: a real JPEG off disk, decoded
 * and re-encoded by a real browser, posted to the real Server Action, stored in
 * real Supabase Storage under real Row Level Security. Then the URLs on the
 * roster are fetched and checked for a 200 and an image content type, which is
 * the only assertion that can tell "the avatar is there" from "the avatar is a
 * broken link that degraded politely".
 *
 * The five projections are covered exhaustively at database level in
 * `tests/db/player-avatar-projections.test.ts`; this file is about the round
 * trip.
 */

const LANDSCAPE = join(__dirname, '../fixtures/avatar-landscape.jpg');
const PORTRAIT = join(__dirname, '../fixtures/avatar-portrait.jpg');

/** Uploads a photo for the signed-in user through the profile page. */
async function uploadAvatar(page: Page, file: string): Promise<string> {
  await page.goto('/profile');
  await expect(page.getByTestId('avatar-picker')).toBeVisible();
  await page.waitForLoadState('networkidle');

  await page.locator('input[type="file"]#avatar-file').setInputFiles(file);
  await page.getByRole('button', { name: 'Save photo' }).click();
  await expect(page.getByText('Photo saved.')).toBeVisible();

  // "Photo saved." means the object is stored and the profile points at it. It
  // does not mean this page is rendering that object's URL yet: the picker
  // holds its local `blob:` preview — the same bytes — until `router.refresh()`
  // brings the new server prop down, precisely so the previous photo never
  // flashes back under the success message.
  //
  // This used to read the attribute the moment the notice appeared and get the
  // managed URL anyway, but only by accident: before the picker held its
  // preview there was no `<img>` at all in that window, so `getAttribute` was
  // really waiting for the element to exist. Waiting for the URL itself is the
  // condition this helper actually means.
  const image = page.getByTestId('avatar-picker').locator('img');
  await expect(
    image,
    'the saved avatar should settle on a managed Storage object',
  ).toHaveAttribute('src', /\/storage\/v1\/object\/public\/avatars\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/);

  return (await image.getAttribute('src')) ?? '';
}

/** The confirmed-roster list item for one player. */
function rosterRow(page: Page, player: TestUser) {
  return page
    .getByRole('listitem')
    .filter({ hasText: `${player.firstName} ${player.lastName}` })
    .first();
}

test.describe('player avatars', () => {
  test('an uploaded avatar never reaches another member, on either projection', async ({
    factory,
    asUser,
  }) => {
    // INVERTED BY APP REVIEW GUIDELINE 1.2.
    //
    // This test used to assert that Alice's and Bob's faces appeared on Carol's
    // roster. A profile photo is the one piece of user content in MatchDay that
    // the text filter cannot read, and 1.2 asks that unmoderated material not be
    // distributed — so it is not, and this is the assertion that it is not.
    //
    // The photos are still genuinely uploaded, because "no photo ever existed"
    // would pass against a product that had simply lost the feature.
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 8 });

    const alice = await factory.createMember(league);
    const bob = await factory.createMember(league);
    const carol = await factory.createMember(league);

    const alicePage = await asUser(alice.email);
    const bobPage = await asUser(bob.email);
    const carolPage = await asUser(carol.email);

    const aliceAvatar = await uploadAvatar(alicePage, LANDSCAPE);
    const bobAvatar = await uploadAvatar(bobPage, PORTRAIT);
    expect(aliceAvatar).not.toBe(bobAvatar);

    for (const player of [alice, bob, carol]) {
      await factory.joinMatch(match, player);
    }

    // ── The confirmed roster, as Carol sees it ────────────────────────────
    await carolPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expectNoServerError(carolPage);

    for (const player of [alice, bob, carol]) {
      const row = rosterRow(carolPage, player);
      await expect(row.locator('img')).toHaveCount(0);
      await expect(row).toContainText(player.firstName.slice(0, 1).toUpperCase());
    }

    // Not merely unrendered — the object key never reaches the page at all, so
    // it cannot be recovered from the markup and fetched by hand.
    const rosterHtml = await carolPage.content();
    expect(rosterHtml).not.toContain(aliceAvatar);
    expect(rosterHtml).not.toContain(bobAvatar);

    // ── Published teams, a different projection ───────────────────────────
    await factory.callAs(league.admin, 'select public.ensure_match_teams($1)', [match.id]);
    await factory.callAs(league.admin, 'select public.randomize_match_teams($1)', [match.id]);
    await factory.callAs(league.admin, 'select public.publish_match_teams($1)', [match.id]);

    await carolPage.reload();
    const teams = carolPage.getByRole('group');
    await expect(teams.first()).toBeVisible();

    const teamsSection = carolPage.locator('section').filter({ hasText: 'Teams' }).last();
    await expect(teamsSection.locator('img')).toHaveCount(0);
    expect(await carolPage.content()).not.toContain(aliceAvatar);

    // ── Alice still has her own photo ─────────────────────────────────────
    // Nothing was deleted. The person who chose the photo still sees it.
    await alicePage.goto('/profile');
    await expect(alicePage.getByTestId('avatar-picker').locator('img')).toHaveAttribute(
      'src',
      aliceAvatar,
    );
  });

  test('a legacy pasted address never renders for another member', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 8 });
    const alice = await factory.createMember(league);
    const bob = await factory.createMember(league);

    // A profile from before uploads existed. Only reachable as a fixture now.
    await factory.setProfilePhotoUrl(alice.id, 'https://cdn.elsewhere.test/people/alice.jpg');
    await factory.joinMatch(match, alice);
    await factory.joinMatch(match, bob);

    const alicePage = await asUser(alice.email);
    const bobPage = await asUser(bob.email);

    // Alice still sees it on her own profile — that is the one place it
    // renders, and the request is one she is already making.
    await alicePage.goto('/profile');
    await expect(alicePage.getByTestId('avatar-picker').locator('img')).toHaveAttribute(
      'src',
      'https://cdn.elsewhere.test/people/alice.jpg',
    );

    // Bob does not, anywhere. Rendering it would send Bob's IP address and user
    // agent to a host neither of them chose — and since 1.2, no member's
    // photograph reaches another member by any route at all.
    await bobPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(rosterRow(bobPage, alice).locator('img')).toHaveCount(0);
    expect(await bobPage.content()).not.toContain('cdn.elsewhere.test');
  });

  test('the header shows the signed-in user their own avatar', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const alice = await factory.createMember(league);
    const page = await asUser(alice.email);

    const avatar = await uploadAvatar(page, LANDSCAPE);

    await page.goto('/dashboard');
    const header = page.locator('header').first();
    await expect(header.locator('img')).toHaveAttribute('src', avatar);

    // And exactly one of them: the dashboard greeting deliberately does not
    // repeat the same face a hundred pixels lower.
    await expect(page.locator('img')).toHaveCount(1);
  });
});

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
  test('two uploaded avatars appear on the roster and on published teams', async ({
    factory,
    asUser,
  }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 8 });

    const alice = await factory.createMember(league);
    const bob = await factory.createMember(league);
    // A third member who never uploads anything — the initials case, tested in
    // the same list rather than in a separate world where nobody has a photo.
    const carol = await factory.createMember(league);

    const alicePage = await asUser(alice.email);
    const bobPage = await asUser(bob.email);
    const carolPage = await asUser(carol.email);

    const aliceAvatar = await uploadAvatar(alicePage, LANDSCAPE);
    const bobAvatar = await uploadAvatar(bobPage, PORTRAIT);

    // Distinct objects: each upload writes a new uuid, so two people cannot
    // collide and one cannot be served the other's cached face.
    expect(aliceAvatar).not.toBe(bobAvatar);

    for (const player of [alice, bob, carol]) {
      await factory.joinMatch(match, player);
    }

    // ── The confirmed roster, as Carol sees it ────────────────────────────
    await carolPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expectNoServerError(carolPage);

    const aliceRow = rosterRow(carolPage, alice);
    const bobRow = rosterRow(carolPage, bob);
    const carolRow = rosterRow(carolPage, carol);

    await expect(aliceRow.locator('img')).toHaveAttribute('src', aliceAvatar);
    await expect(bobRow.locator('img')).toHaveAttribute('src', bobAvatar);

    // Carol uploaded nothing, so her own row shows initials — no <img> at all,
    // rather than a broken one.
    await expect(carolRow.locator('img')).toHaveCount(0);
    await expect(carolRow).toContainText(carol.firstName.slice(0, 1).toUpperCase());

    // ── The images genuinely load ─────────────────────────────────────────
    for (const [label, url] of [
      ['alice', aliceAvatar],
      ['bob', bobAvatar],
    ] as const) {
      const response = await carolPage.request.get(url);
      expect(response.status(), label).toBe(200);
      expect(response.headers()['content-type'], label).toContain('image/jpeg');
    }

    // ── Published teams ───────────────────────────────────────────────────
    await factory.callAs(league.admin, 'select public.ensure_match_teams($1)', [match.id]);
    await factory.callAs(league.admin, 'select public.randomize_match_teams($1)', [match.id]);
    await factory.callAs(league.admin, 'select public.publish_match_teams($1)', [match.id]);

    await carolPage.reload();
    const teams = carolPage.getByRole('group');
    await expect(teams.first()).toBeVisible();

    // A different projection — `match_published_teams` rather than
    // `match_confirmed_roster` — so the avatar has to have been added to both.
    const teamsSection = carolPage.locator('section').filter({ hasText: 'Teams' }).last();
    await expect(teamsSection.locator(`img[src="${aliceAvatar}"]`)).toHaveCount(1);
    await expect(teamsSection.locator(`img[src="${bobAvatar}"]`)).toHaveCount(1);
  });

  test('a removed avatar disappears from other members rosters', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const match = await factory.createMatch(league, { capacity: 8 });
    const alice = await factory.createMember(league);
    const bob = await factory.createMember(league);

    const alicePage = await asUser(alice.email);
    const bobPage = await asUser(bob.email);

    await uploadAvatar(alicePage, LANDSCAPE);
    await factory.joinMatch(match, alice);
    await factory.joinMatch(match, bob);

    await bobPage.goto(`/leagues/${league.slug}/matches/${match.id}`);
    await expect(rosterRow(bobPage, alice).locator('img')).toHaveCount(1);

    await alicePage.getByRole('button', { name: 'Remove photo' }).click();
    await expect(alicePage.getByText('Photo removed.')).toBeVisible();

    await bobPage.reload();
    // Back to initials for everybody, not just for Alice — removal is a real
    // withdrawal of the photo, not a change only its owner can see.
    await expect(rosterRow(bobPage, alice).locator('img')).toHaveCount(0);
    await expect(rosterRow(bobPage, alice)).toContainText(
      alice.firstName.slice(0, 1).toUpperCase(),
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
    // agent to a host neither of them chose.
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

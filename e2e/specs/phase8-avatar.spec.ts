import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, expectNoServerError, test } from '../support/fixtures';

/**
 * Profile photo upload, end to end, with nothing simulated.
 *
 * A real browser opens a real JPEG from disk, decodes it, centre-crops it onto
 * a real canvas, re-encodes it, and posts the result to a real Server Action,
 * which stores it in a real Supabase Storage bucket under real Row Level
 * Security. The `<img>` that appears afterwards is fetched from the public
 * object endpoint by the browser itself.
 *
 * That end-to-end-ness is the point. The unit and component suites stub the
 * canvas — jsdom has no 2D context — so this is the only place the encoder
 * actually runs, and the only place the round trip from "tap a file" to "a face
 * on the page" is exercised as one thing.
 *
 * Parallel-safe: every test creates its own league and its own member.
 */

// `__dirname`, not `import.meta.url`: Playwright transpiles specs to CommonJS,
// where `import.meta` is a syntax error rather than a runtime undefined.
const LANDSCAPE = join(__dirname, '../fixtures/avatar-landscape.jpg');
const PORTRAIT = join(__dirname, '../fixtures/avatar-portrait.jpg');

/** The picker's file input, which is visually hidden but present and enabled. */
function picker(page: Page) {
  return page.locator('input[type="file"]#avatar-file');
}

function avatarImage(page: Page) {
  return page.getByTestId('avatar-picker').locator('img');
}

/**
 * The picker's own alert.
 *
 * Scoped, because Next.js renders a permanent empty `role="alert"` route
 * announcer into every page — an unscoped `getByRole('alert')` matches that
 * first and reports "" forever.
 */
function pickerAlert(page: Page) {
  return page.getByTestId('avatar-picker').getByRole('alert');
}

/**
 * Waits until the client component is actually listening.
 *
 * `setInputFiles` sets the DOM property and dispatches a native `change`. If it
 * runs before hydration there is no React listener attached yet, the event goes
 * nowhere, and the test times out waiting for a preview that was never
 * requested. Nobody hits this on a phone — it takes longer than a page load to
 * find the button — but Playwright acts within milliseconds of `goto`
 * resolving. Same reason `settledUrl` in `support/fixtures.ts` waits here.
 */
async function openPicker(page: Page): Promise<void> {
  await expect(page.getByTestId('avatar-picker')).toBeVisible();
  await page.waitForLoadState('networkidle');
}

/** Chooses a file and waits for the on-device processing to finish. */
async function choose(page: Page, file: string): Promise<void> {
  await openPicker(page);
  await picker(page).setInputFiles(file);
  // Save only appears once the processed JPEG exists, so its arrival *is* the
  // signal that decoding, cropping and encoding all succeeded.
  await expect(page.getByRole('button', { name: 'Save photo' })).toBeVisible();
}

async function save(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save photo' }).click();
  await expect(page.getByText('Photo saved.')).toBeVisible();
}

/** The URL the avatar is currently rendering, once one exists. */
async function avatarSrc(page: Page): Promise<string> {
  await expect(avatarImage(page)).toBeVisible();
  return (await avatarImage(page).getAttribute('src')) ?? '';
}

test.describe('profile photo', () => {
  test('a chosen photo previews, saves, and survives a reload', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const page = await asUser(member.email);

    await page.goto('/profile');
    await expectNoServerError(page);

    // Initials to begin with — a new member has no photo.
    await expect(page.getByRole('img', { name: /no profile photo/ })).toBeVisible();
    await expect(page.getByText('Add photo')).toBeVisible();

    await choose(page, LANDSCAPE);

    // The preview is local: an object URL, not anything that has been uploaded.
    expect(await avatarSrc(page)).toMatch(/^blob:/);

    await save(page);

    const stored = await avatarSrc(page);
    // Now a public Storage object under this member's own folder, named with a
    // uuid the server generated.
    expect(stored).toContain('/storage/v1/object/public/avatars/');
    expect(stored).toContain(`/avatars/${member.id}/`);
    expect(stored).toMatch(/[0-9a-f-]{36}\.jpg$/);

    // Fetched by the browser from the public endpoint, with no session — the
    // proof that a public bucket is what makes an <img> tag work.
    const response = await page.request.get(stored);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('image/jpeg');

    await page.reload();
    await expect(avatarImage(page)).toHaveAttribute('src', stored);
    await expectNoServerError(page);
  });

  test('the stored image is a 512x512 square', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const page = await asUser(member.email);

    await page.goto('/profile');
    await choose(page, LANDSCAPE);
    await save(page);

    const stored = await avatarSrc(page);

    // Decoded in the browser, so this measures the bytes that were actually
    // stored rather than the CSS the circle is drawn with. A 900x600 source
    // arriving as 512x512 is the crop and the resize, both confirmed.
    const size = await page.evaluate(
      (src) =>
        new Promise<{ width: number; height: number }>((resolve, reject) => {
          const image = new Image();
          image.crossOrigin = 'anonymous';
          image.onload = () => {
            resolve({ width: image.naturalWidth, height: image.naturalHeight });
          };
          image.onerror = () => {
            reject(new Error('the stored avatar could not be decoded'));
          };
          image.src = src;
        }),
      stored,
    );

    expect(size).toEqual({ width: 512, height: 512 });
  });

  test('changing the photo replaces it with a different object', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const page = await asUser(member.email);

    await page.goto('/profile');
    await choose(page, LANDSCAPE);
    await save(page);
    const first = await avatarSrc(page);

    await expect(page.getByText('Change photo')).toBeVisible();
    await choose(page, PORTRAIT);
    await save(page);
    const second = await avatarSrc(page);

    // A new uuid, never an overwrite: that is what lets a CDN cache an avatar
    // forever without ever serving a stale face.
    expect(second).not.toBe(first);
    expect(second).toContain(`/avatars/${member.id}/`);

    await page.reload();
    await expect(avatarImage(page)).toHaveAttribute('src', second);

    // The old object is cleaned up after the profile update succeeds.
    await expect(async () => {
      expect((await page.request.get(first)).status()).not.toBe(200);
    }).toPass({ timeout: 10_000 });
  });

  test('removing the photo brings the initials back', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const page = await asUser(member.email);

    await page.goto('/profile');
    await choose(page, LANDSCAPE);
    await save(page);
    const stored = await avatarSrc(page);

    await page.getByRole('button', { name: 'Remove photo' }).click();
    await expect(page.getByText('Photo removed.')).toBeVisible();

    await expect(avatarImage(page)).toHaveCount(0);
    await expect(page.getByRole('img', { name: /no profile photo/ })).toBeVisible();

    await page.reload();
    await expect(avatarImage(page)).toHaveCount(0);
    await expect(page.getByText('Add photo')).toBeVisible();

    await expect(async () => {
      expect((await page.request.get(stored)).status()).not.toBe(200);
    }).toPass({ timeout: 10_000 });
  });

  test('a cancelled selection uploads nothing', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const page = await asUser(member.email);

    await page.goto('/profile');
    await choose(page, LANDSCAPE);
    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.getByRole('button', { name: 'Save photo' })).toHaveCount(0);
    await page.reload();
    await expect(avatarImage(page)).toHaveCount(0);
  });

  test('a non-image file is refused with a sentence, not a crash', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const page = await asUser(member.email);

    await page.goto('/profile');
    await openPicker(page);
    await picker(page).setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('this is not a photograph'),
    });

    await expect(pickerAlert(page)).toContainText('Try another photo');
    await expect(page.getByRole('button', { name: 'Save photo' })).toHaveCount(0);
    await expectNoServerError(page);
  });

  test('a file that claims to be a JPEG but is not is refused', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const page = await asUser(member.email);

    await page.goto('/profile');
    await openPicker(page);
    // Declared `image/jpeg`, with bytes that are nothing of the sort. The
    // browser cannot decode it, so this never reaches the server — and the
    // server's magic-byte check is asserted separately in the unit suite,
    // which can post directly to the action.
    await picker(page).setInputFiles({
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('<script>alert(1)</script>'),
    });

    await expect(pickerAlert(page)).toContainText('Try another photo');
    await expect(page.getByRole('button', { name: 'Save photo' })).toHaveCount(0);
  });

  test('there is no field for pasting an image address', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);
    const page = await asUser(member.email);

    await page.goto('/profile');

    // The field this feature replaced. Its absence from the shipped page is the
    // regression this test exists for.
    await expect(page.locator('input[name="profile_photo_url"]')).toHaveCount(0);
    await expect(page.locator('input[type="url"]')).toHaveCount(0);
    await expect(page.getByLabel('Profile photo URL')).toHaveCount(0);
  });

  test('a legacy pasted address still renders and can be removed', async ({ factory, asUser }) => {
    const league = await factory.createLeague();
    const member = await factory.createMember(league);

    // A profile from before this feature: an external URL in the old column,
    // written the only way it now can be. Pointed at the local stack's own
    // Storage so the browser can actually load it.
    const legacy = 'https://127.0.0.1:54321/nonexistent-legacy-avatar.jpg';
    await factory.setProfilePhotoUrl(member.id, legacy);

    const page = await asUser(member.email);
    await page.goto('/profile');

    // It renders as the avatar even though it will fail to load — and when it
    // does fail, the initials are what shows, never a broken-image glyph.
    await expect(page.getByTestId('avatar-picker')).toContainText(
      member.firstName.slice(0, 1).toUpperCase(),
    );
    await expect(page.getByText('Change photo')).toBeVisible();

    await page.getByRole('button', { name: 'Remove photo' }).click();
    await expect(page.getByText('Photo removed.')).toBeVisible();

    await page.reload();
    await expect(page.getByText('Add photo')).toBeVisible();
    expect(await factory.readProfilePhoto(member.id)).toEqual({ path: null, url: null });
  });
});

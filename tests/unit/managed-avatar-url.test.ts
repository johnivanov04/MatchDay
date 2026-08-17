import { describe, expect, it } from 'vitest';

/**
 * `managedAvatarUrl` — the only thing in the product that turns a projected
 * avatar path into an `<img src>`.
 *
 * ── WHY THIS FILE IS MOSTLY REJECTIONS ─────────────────────────────────────
 *
 * The happy path is one line of string concatenation and could hardly be wrong.
 * The interesting property is the other one: **anything that is not exactly
 * `{uuid}/{uuid}.jpg` must become `null`**, because whatever is returned is
 * pasted into the address a browser is pointed at. A full `https://…` value, a
 * protocol-relative `//host`, a traversal or an extra segment would each, if
 * waved through, put a URL of somebody else's choosing on a roster page.
 *
 * That cannot currently happen — `profiles_photo_path_shape` refuses to store
 * any of them and no projection returns the legacy column — but "the database
 * would have caught it" is not a reason to concatenate an unvalidated value
 * into a URL.
 *
 * The second half of the file pins that adding this helper did **not** loosen
 * `isManagedAvatarPath`, which guards deletion and must stay ownership-aware.
 */

// `getPublicEnv` captures `process.env` into a module constant when it loads,
// so the value has to be in place before the import below.
const SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-for-tests';
process.env.NEXT_PUBLIC_SITE_URL = 'https://matchday.test';

const { isManagedAvatarPath, managedAvatarUrl } = await import('@/lib/profile/avatar');

const OWNER = '11111111-1111-4111-8111-000000000003';
const OTHER = '11111111-1111-4111-8111-000000000004';
const FILE = 'a0000000-0000-4000-8000-000000000001';

describe('a valid managed path', () => {
  it('becomes the public Storage URL for the configured project', () => {
    expect(managedAvatarUrl(`${OWNER}/${FILE}.jpg`)).toBe(
      `${SUPABASE_URL}/storage/v1/object/public/avatars/${OWNER}/${FILE}.jpg`,
    );
  });

  it('resolves for a path belonging to somebody else', () => {
    // The whole reason this helper exists alongside `isManagedAvatarPath`:
    // rendering another member's avatar is the normal case, and the caller has
    // no idea what their auth user id is — the projections return
    // `membership_id` and deliberately no `user_id`.
    expect(managedAvatarUrl(`${OTHER}/${FILE}.jpg`)).toBe(
      `${SUPABASE_URL}/storage/v1/object/public/avatars/${OTHER}/${FILE}.jpg`,
    );
  });

  it('accepts a real crypto.randomUUID() pair, which is what the server writes', () => {
    const path = `${crypto.randomUUID()}/${crypto.randomUUID()}.jpg`;
    expect(managedAvatarUrl(path)).toBe(
      `${SUPABASE_URL}/storage/v1/object/public/avatars/${path}`,
    );
  });

  it('never hard-codes a project reference', () => {
    // A literal would work in production and point at somebody else's project
    // from a preview deployment.
    expect(managedAvatarUrl(`${OWNER}/${FILE}.jpg`)?.startsWith(SUPABASE_URL)).toBe(true);
  });
});

describe('everything else becomes null', () => {
  it('rejects nullish and empty values', () => {
    expect(managedAvatarUrl(null)).toBeNull();
    expect(managedAvatarUrl(undefined)).toBeNull();
    expect(managedAvatarUrl('')).toBeNull();
    expect(managedAvatarUrl('   ')).toBeNull();
  });

  it('rejects a malformed owner folder', () => {
    for (const folder of [
      'not-a-uuid',
      `${OWNER}x`,
      OWNER.slice(0, -1),
      '..',
      '.',
      'avatars',
    ]) {
      expect(managedAvatarUrl(`${folder}/${FILE}.jpg`), folder).toBeNull();
    }
  });

  it('rejects an upper-case uuid in either position', () => {
    // `OWNER` above is all digits, so upper-casing it is a no-op and would
    // assert nothing. This uses a value with hex letters in it, in both the
    // folder and the filename, so the case-sensitivity is genuinely exercised.
    const HEX = 'abcdef01-1111-4111-8111-00000000000f';

    expect(managedAvatarUrl(`${HEX}/${FILE}.jpg`)).not.toBeNull();
    expect(managedAvatarUrl(`${HEX.toUpperCase()}/${FILE}.jpg`)).toBeNull();
    expect(managedAvatarUrl(`${OWNER}/${HEX}.jpg`)).not.toBeNull();
    expect(managedAvatarUrl(`${OWNER}/${HEX.toUpperCase()}.jpg`)).toBeNull();
  });

  it('rejects a malformed filename', () => {
    for (const file of [
      'avatar.jpg',
      `${FILE.toUpperCase()}.jpg`,
      `${FILE}x.jpg`,
      `x${FILE}.jpg`,
      `${FILE.slice(0, -1)}.jpg`,
      FILE,
    ]) {
      expect(managedAvatarUrl(`${OWNER}/${file}`), file).toBeNull();
    }
  });

  it('rejects the wrong extension', () => {
    for (const extension of ['.png', '.jpeg', '.JPG', '.gif', '.svg', '.jpg.html', '']) {
      expect(managedAvatarUrl(`${OWNER}/${FILE}${extension}`), extension).toBeNull();
    }
  });

  it('rejects nesting and extra segments', () => {
    for (const path of [
      `${OWNER}/nested/${FILE}.jpg`,
      `${OWNER}/${OTHER}/${FILE}.jpg`,
      `avatars/${OWNER}/${FILE}.jpg`,
      `${FILE}.jpg`,
      `${OWNER}/`,
      `/${OWNER}/${FILE}.jpg`,
      `${OWNER}//${FILE}.jpg`,
      `${OWNER}/${FILE}.jpg/`,
    ]) {
      expect(managedAvatarUrl(path), path).toBeNull();
    }
  });

  it('rejects traversal', () => {
    for (const path of [
      `../${OWNER}/${FILE}.jpg`,
      `${OWNER}/../${OTHER}/${FILE}.jpg`,
      `${OWNER}/..%2F${FILE}.jpg`,
      `..%2F..%2F${FILE}.jpg`,
    ]) {
      expect(managedAvatarUrl(path), path).toBeNull();
    }
  });

  it('rejects a full URL, which is what a legacy value looks like', () => {
    for (const value of [
      'https://cdn.elsewhere.test/people/sam.jpg',
      'http://cdn.elsewhere.test/people/sam.jpg',
      `${SUPABASE_URL}/storage/v1/object/public/avatars/${OWNER}/${FILE}.jpg`,
      'javascript:alert(1)',
      'data:image/jpeg;base64,AAAA',
    ]) {
      // If any of these resolved, a legacy address that somehow reached a
      // projection would render in another member's browser.
      expect(managedAvatarUrl(value), value).toBeNull();
    }
  });

  it('rejects a protocol-relative URL', () => {
    for (const value of ['//cdn.elsewhere.test/sam.jpg', `//${OWNER}/${FILE}.jpg`]) {
      // `//host/path` inherits the page's scheme and loads from `host`. It also
      // happens to split into segments that could look plausible, which is
      // exactly why it is worth its own case.
      expect(managedAvatarUrl(value), value).toBeNull();
    }
  });

  it('rejects a query string or fragment smuggled onto a valid path', () => {
    for (const suffix of ['?x=1', '#frag', '%00.png']) {
      expect(managedAvatarUrl(`${OWNER}/${FILE}.jpg${suffix}`), suffix).toBeNull();
    }
  });
});

describe('isManagedAvatarPath is unchanged and still ownership-aware', () => {
  it('accepts the caller own path', () => {
    expect(isManagedAvatarPath(`${OWNER}/${FILE}.jpg`, OWNER)).toBe(true);
  });

  it('still refuses a path under another member folder', () => {
    // The single assertion that keeps a replacement from deleting somebody
    // else's photo. `managedAvatarUrl` deliberately does not make this check;
    // this one must never stop making it.
    expect(isManagedAvatarPath(`${OTHER}/${FILE}.jpg`, OWNER)).toBe(false);
  });

  it('is strictly stronger than the render check', () => {
    const someoneElses = `${OTHER}/${FILE}.jpg`;

    // Renderable, and not deletable. That difference is the entire reason
    // there are two functions.
    expect(managedAvatarUrl(someoneElses)).not.toBeNull();
    expect(isManagedAvatarPath(someoneElses, OWNER)).toBe(false);
  });

  it('rejects everything the render check rejects, too', () => {
    for (const path of [
      '',
      `${OWNER}/nested/${FILE}.jpg`,
      `../${OWNER}/${FILE}.jpg`,
      `${OWNER}/${FILE}.png`,
      'https://cdn.elsewhere.test/sam.jpg',
      `//${OWNER}/${FILE}.jpg`,
    ]) {
      expect(isManagedAvatarPath(path, OWNER), path).toBe(false);
      expect(managedAvatarUrl(path), path).toBeNull();
    }
  });
});

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Which image a profile shows, and what counts as one this product owns.
 *
 * `avatarImageUrl` decides what renders. `isManagedAvatarPath` decides what may
 * be **deleted**, and is the more dangerous of the two: it is the only thing
 * standing between "clean up the old avatar" and a delete call built from a
 * value that came from somewhere else entirely.
 */

// `getPublicEnv` captures `process.env` into a module constant when it loads,
// so the value has to be in place before the import below rather than inside a
// `beforeEach`.
const SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-for-tests';
process.env.NEXT_PUBLIC_SITE_URL = 'https://matchday.test';

const { avatarImageUrl, avatarInitials, avatarLabel, avatarPublicUrl, isManagedAvatarPath } =
  await import('@/lib/profile/avatar');

const OWNER = '11111111-1111-4111-8111-000000000003';
const OTHER = '11111111-1111-4111-8111-000000000004';
const UUID = 'a0000000-0000-4000-8000-000000000001';

const managed = (id: string, uuid = UUID) => `${id}/${uuid}.jpg`;

function source(overrides: Partial<Parameters<typeof avatarImageUrl>[0]> = {}) {
  return {
    id: OWNER,
    profile_photo_path: null,
    profile_photo_url: null,
    ...overrides,
  };
}

beforeAll(() => {
  // If this ever stops holding, every URL assertion below is meaningless.
  expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe(SUPABASE_URL);
});

describe('isManagedAvatarPath', () => {
  it('accepts the caller own uuid-named jpg', () => {
    expect(isManagedAvatarPath(managed(OWNER), OWNER)).toBe(true);
    expect(isManagedAvatarPath(managed(OWNER, crypto.randomUUID()), OWNER)).toBe(true);
  });

  it('refuses another member folder', () => {
    // The single most important line in this file. A true here would let a
    // replacement delete somebody else's avatar.
    expect(isManagedAvatarPath(managed(OTHER), OWNER)).toBe(false);
  });

  it('refuses nesting, traversal and separator tricks', () => {
    for (const path of [
      `${OWNER}/nested/${UUID}.jpg`,
      `${OWNER}/../${OTHER}/${UUID}.jpg`,
      `../${OWNER}/${UUID}.jpg`,
      `/${OWNER}/${UUID}.jpg`,
      `${OWNER}//${UUID}.jpg`,
      `${OWNER}/${UUID}.jpg/`,
    ]) {
      expect(isManagedAvatarPath(path, OWNER), path).toBe(false);
    }
  });

  it('refuses a filename that is not a lower-case uuid ending in .jpg', () => {
    for (const filename of [
      'avatar.jpg',
      `${UUID}.png`,
      `${UUID}.jpeg`,
      `${UUID.toUpperCase()}.jpg`,
      `${UUID}.jpg.html`,
      `${UUID}`,
      `x${UUID}.jpg`,
    ]) {
      expect(isManagedAvatarPath(`${OWNER}/${filename}`, OWNER), filename).toBe(false);
    }
  });

  it('refuses a URL, an empty string and a nullish value', () => {
    expect(isManagedAvatarPath(`${SUPABASE_URL}/storage/v1/object/public/avatars/x.jpg`, OWNER)).toBe(
      false,
    );
    expect(isManagedAvatarPath('', OWNER)).toBe(false);
    expect(isManagedAvatarPath(null, OWNER)).toBe(false);
    expect(isManagedAvatarPath(undefined, OWNER)).toBe(false);
  });
});

describe('avatarPublicUrl', () => {
  it('builds the Supabase public object address from configuration', () => {
    expect(avatarPublicUrl(managed(OWNER))).toBe(
      `${SUPABASE_URL}/storage/v1/object/public/avatars/${OWNER}/${UUID}.jpg`,
    );
  });

  it('never hard-codes a project reference', () => {
    // A URL assembled from a literal would work in production and point at
    // somebody else's project from a preview deployment.
    expect(avatarPublicUrl(managed(OWNER)).startsWith(SUPABASE_URL)).toBe(true);
  });
});

describe('avatarImageUrl priority', () => {
  it('prefers a managed object over a legacy address', () => {
    const url = avatarImageUrl(
      source({
        profile_photo_path: managed(OWNER),
        profile_photo_url: 'https://legacy.test/old.jpg',
      }),
    );

    // Both populated is not a state this product creates — a managed upload
    // clears the URL — but a legacy row is not something to trust to stay
    // tidy, so the order is defined rather than assumed.
    expect(url).toBe(`${SUPABASE_URL}/storage/v1/object/public/avatars/${OWNER}/${UUID}.jpg`);
  });

  it('falls back to a legacy address', () => {
    expect(avatarImageUrl(source({ profile_photo_url: 'https://legacy.test/old.jpg' }))).toBe(
      'https://legacy.test/old.jpg',
    );
  });

  it('returns null when there is neither', () => {
    expect(avatarImageUrl(source())).toBeNull();
    expect(avatarImageUrl(null)).toBeNull();
    expect(avatarImageUrl(source({ profile_photo_url: '' }))).toBeNull();
  });

  it('ignores a stored path belonging to somebody else', () => {
    const url = avatarImageUrl(
      source({
        profile_photo_path: managed(OTHER),
        profile_photo_url: 'https://legacy.test/old.jpg',
      }),
    );

    // Unreachable through the constraint, and still not rendered: a URL
    // assembled from an unvalidated column is not a thing worth leaving
    // possible.
    expect(url).toBe('https://legacy.test/old.jpg');
  });
});

describe('avatarInitials', () => {
  it('takes the first letter of each name, upper-cased', () => {
    expect(avatarInitials('sam', 'okafor')).toBe('SO');
    expect(avatarInitials('Adaeze', 'Nwachukwu')).toBe('AN');
  });

  it('copes with one name, no name and whitespace', () => {
    expect(avatarInitials('Sam', null)).toBe('S');
    expect(avatarInitials(null, 'Okafor')).toBe('O');
    expect(avatarInitials('  ', '  ')).toBe('?');
    expect(avatarInitials(null, null)).toBe('?');
  });

  it('takes whole characters from a non-Latin or emoji name', () => {
    // `charAt` would return half of an astral-plane character and render as a
    // replacement glyph.
    expect(avatarInitials('Đorđe', 'Ćirić')).toBe('ĐĆ');
    expect(avatarInitials('🎯', 'Smith')).toBe('🎯S');
  });
});

describe('avatarLabel', () => {
  it('joins the names for alt text', () => {
    expect(avatarLabel('Sam', 'Okafor')).toBe('Sam Okafor');
    expect(avatarLabel('Sam', null)).toBe('Sam');
  });

  it('says something rather than nothing when there is no name', () => {
    expect(avatarLabel(null, null)).toBe('this member');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ObservabilityLog from '@/lib/observability/log';

/**
 * The avatar Server Action, treated as what it is: a public HTTP endpoint.
 *
 * Every test here submits something a browser form never would, because the
 * form is not the threat model. A Server Action has a generated URL that anyone
 * can POST to with any body, so what matters is not "does the happy path work"
 * — the E2E suite answers that against a real browser — but what happens when
 * the submission is hostile, malformed, or lying.
 *
 * The other half is failure ordering. There is no transaction spanning object
 * storage and PostgreSQL, so the action's guarantee is behavioural: whichever
 * step fails, the player is left with a working profile. Several tests below
 * assert the *order* of calls rather than their results, because the order is
 * the guarantee.
 */

const OWNER = '11111111-1111-4111-8111-000000000003';
const OTHER = '11111111-1111-4111-8111-000000000004';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireCurrentProfile: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  /** Every storage/database call, in the order it happened. */
  trace: [] as string[],
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/auth/session', () => ({
  requireCurrentProfile: mocks.requireCurrentProfile,
  requireSessionUser: vi.fn(),
  getSessionUser: vi.fn(),
  getCurrentProfile: vi.fn(),
}));
vi.mock('@/lib/observability/log', async (importOriginal) => ({
  ...(await importOriginal<typeof ObservabilityLog>()),
  logInfo: mocks.logInfo,
  logWarn: mocks.logWarn,
  logError: mocks.logError,
}));

interface UploadCall {
  bucket: string;
  path: string;
  body: unknown;
  options: { contentType?: string; upsert?: boolean };
}

const uploads: UploadCall[] = [];
const removals: { bucket: string; paths: string[] }[] = [];
const updates: Record<string, unknown>[] = [];

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, body: unknown, options: UploadCall['options']) => {
          uploads.push({ bucket, path, body, options });
          mocks.trace.push('storage.upload');
          return mocks.upload();
        },
        remove: (paths: string[]) => {
          removals.push({ bucket, paths });
          mocks.trace.push('storage.remove');
          return mocks.remove();
        },
      }),
    },
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => ({
        eq: (_column: string, _value: string) => {
          updates.push(values);
          mocks.trace.push(`${table}.update`);
          return mocks.update();
        },
      }),
    }),
  }),
}));

const { uploadAvatarAction, removeAvatarAction } = await import('@/server/actions/avatar');
const { DomainError } = await import('@/lib/errors');

/**
 * A real JPEG byte sequence: SOI, APP0/JFIF, EOI.
 *
 * Typed `Uint8Array<ArrayBuffer>` because `BlobPart` requires a view backed by
 * a plain `ArrayBuffer`, and the default `Uint8Array` type admits a
 * `SharedArrayBuffer`.
 */
function jpegBytes(size = 512): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(Math.max(size, 20)));
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46], 0);
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return bytes;
}

function jpegFile(size = 512, type = 'image/jpeg'): File {
  return new File([jpegBytes(size)], 'avatar.jpg', { type });
}

function formWith(file: File | null, extra: Record<string, string> = {}): FormData {
  const data = new FormData();
  if (file !== null) {
    data.set('avatar', file);
  }
  for (const [key, value] of Object.entries(extra)) {
    data.set(key, value);
  }
  return data;
}

function profile(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: OWNER,
    first_name: 'Sam',
    last_name: 'Okafor',
    profile_photo_path: null,
    profile_photo_url: null,
    ...overrides,
  };
}

/** Everything the action logged, flattened, for leak scanning. */
function loggedText(): string {
  return JSON.stringify([
    ...mocks.logInfo.mock.calls,
    ...mocks.logWarn.mock.calls,
    ...mocks.logError.mock.calls,
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  uploads.length = 0;
  removals.length = 0;
  updates.length = 0;
  mocks.trace.length = 0;

  mocks.requireCurrentProfile.mockResolvedValue(profile());
  mocks.upload.mockResolvedValue({ data: { path: 'x' }, error: null });
  mocks.remove.mockResolvedValue({ data: [], error: null });
  mocks.update.mockResolvedValue({ error: null });
});

// ══ Who ═══════════════════════════════════════════════════════════════════

describe('the caller is resolved, never submitted', () => {
  it('refuses an unauthenticated upload and touches nothing', async () => {
    mocks.requireCurrentProfile.mockRejectedValue(new DomainError('AUTH_REQUIRED'));

    const result = await uploadAvatarAction(null, formWith(jpegFile()));

    expect(result).toMatchObject({ ok: false, code: 'AUTH_REQUIRED' });
    expect(uploads).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('refuses an unauthenticated remove and touches nothing', async () => {
    mocks.requireCurrentProfile.mockRejectedValue(new DomainError('AUTH_REQUIRED'));

    const result = await removeAvatarAction(null, new FormData());

    expect(result).toMatchObject({ ok: false, code: 'AUTH_REQUIRED' });
    expect(updates).toHaveLength(0);
    expect(removals).toHaveLength(0);
  });

  it('ignores a user id submitted in the form', async () => {
    await uploadAvatarAction(
      null,
      formWith(jpegFile(), { user_id: OTHER, id: OTHER, profile_id: OTHER }),
    );

    // The object lands under the *session's* id. Three plausible field names
    // are submitted at once because the guarantee is not "we read the right
    // field" — it is that no field is read at all.
    expect(uploads[0]?.path.startsWith(`${OWNER}/`)).toBe(true);
    expect(uploads[0]?.path).not.toContain(OTHER);
  });

  it('ignores a path submitted in the form', async () => {
    await uploadAvatarAction(
      null,
      formWith(jpegFile(), {
        path: `${OTHER}/aaaaaaaa-0000-4000-8000-000000000001.jpg`,
        profile_photo_path: `${OTHER}/aaaaaaaa-0000-4000-8000-000000000001.jpg`,
      }),
    );

    expect(uploads[0]?.path.startsWith(`${OWNER}/`)).toBe(true);
    expect(updates[0]?.['profile_photo_path']).toBe(uploads[0]?.path);
  });

  it('ignores a legacy url submitted in the form', async () => {
    await uploadAvatarAction(
      null,
      formWith(jpegFile(), { profile_photo_url: 'https://attacker.test/pixel.gif' }),
    );

    // The old text field is gone from the UI; this asserts it is gone from the
    // endpoint as well. The action writes null, not what was submitted.
    expect(updates[0]?.['profile_photo_url']).toBeNull();
  });
});

// ══ What ══════════════════════════════════════════════════════════════════

describe('the file is checked three ways', () => {
  it('refuses a submission with no file at all', async () => {
    const result = await uploadAvatarAction(null, formWith(null));

    expect(result.ok).toBe(false);
    expect(uploads).toHaveLength(0);
  });

  it('refuses a text field pretending to be the file', async () => {
    const data = new FormData();
    data.set('avatar', `${OWNER}/aaaaaaaa-0000-4000-8000-000000000001.jpg`);

    const result = await uploadAvatarAction(null, data);

    expect(result.ok).toBe(false);
    expect(uploads).toHaveLength(0);
  });

  it('refuses a declared content type that is not image/jpeg', async () => {
    for (const type of ['image/png', 'image/svg+xml', 'text/html', 'application/octet-stream', '']) {
      uploads.length = 0;
      const result = await uploadAvatarAction(null, formWith(jpegFile(512, type)));

      expect(result.ok, type).toBe(false);
      expect(uploads, type).toHaveLength(0);
    }
  });

  it('refuses a file that claims image/jpeg but is not one', async () => {
    // The whole point of the magic-byte check. `type` is a string the sender
    // chose; these are the bytes they actually sent.
    const impostors: Record<string, number[]> = {
      png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
      html: [...'<script>alert(1)</script>'].map((character) => character.charCodeAt(0)),
      svg: [...'<svg onload="alert(1)">'].map((character) => character.charCodeAt(0)),
      zip: [0x50, 0x4b, 0x03, 0x04],
      // One byte short of the signature.
      nearly: [0xff, 0xd8, 0x00],
    };

    for (const [label, bytes] of Object.entries(impostors)) {
      uploads.length = 0;
      const padded = new Uint8Array(64);
      padded.set(bytes, 0);
      const file = new File([padded], 'avatar.jpg', { type: 'image/jpeg' });

      const result = await uploadAvatarAction(null, formWith(file));

      expect(result.ok, label).toBe(false);
      expect(uploads, label).toHaveLength(0);
    }
  });

  it('refuses an empty file', async () => {
    const result = await uploadAvatarAction(
      null,
      formWith(new File([], 'avatar.jpg', { type: 'image/jpeg' })),
    );

    expect(result.ok).toBe(false);
    expect(uploads).toHaveLength(0);
  });

  it('refuses a processed file over the 750 KiB cap', async () => {
    const result = await uploadAvatarAction(null, formWith(jpegFile(750 * 1024 + 1)));

    expect(result.ok).toBe(false);
    expect(uploads).toHaveLength(0);
  });

  it('accepts a file exactly at the cap', async () => {
    // The boundary in the permitted direction, so the limit is `>` and not
    // `>=` by accident.
    const result = await uploadAvatarAction(null, formWith(jpegFile(750 * 1024)));

    expect(result.ok).toBe(true);
    expect(uploads).toHaveLength(1);
  });

  it('refuses a file whose declared size lies about its bytes', async () => {
    // `size` is a property of the submission. The action re-measures what it
    // actually received, so a small claim carrying a large body is caught.
    const oversized = new File([jpegBytes(750 * 1024 + 1)], 'avatar.jpg', { type: 'image/jpeg' });
    Object.defineProperty(oversized, 'size', { value: 1024 });

    const result = await uploadAvatarAction(null, formWith(oversized));

    expect(result.ok).toBe(false);
    expect(uploads).toHaveLength(0);
  });
});

// ══ Where ═════════════════════════════════════════════════════════════════

describe('the object path', () => {
  it('is the caller id and a server-generated uuid', async () => {
    await uploadAvatarAction(null, formWith(jpegFile()));

    const [folder, filename] = (uploads[0]?.path ?? '').split('/');
    expect(folder).toBe(OWNER);
    expect(filename?.endsWith('.jpg')).toBe(true);
    expect(filename?.replace('.jpg', '')).toMatch(UUID_PATTERN);
  });

  it('is different on every upload', async () => {
    await uploadAvatarAction(null, formWith(jpegFile()));
    await uploadAvatarAction(null, formWith(jpegFile()));

    // Immutable objects are what let a CDN cache an avatar forever without
    // ever serving a stale face.
    expect(uploads[0]?.path).not.toBe(uploads[1]?.path);
  });

  it('goes to the avatars bucket as image/jpeg, without upsert', async () => {
    await uploadAvatarAction(null, formWith(jpegFile()));

    expect(uploads[0]?.bucket).toBe('avatars');
    expect(uploads[0]?.options).toMatchObject({ contentType: 'image/jpeg', upsert: false });
  });
});

// ══ The commit point ══════════════════════════════════════════════════════

describe('a successful upload', () => {
  it('points the profile at the new object and clears the legacy url', async () => {
    mocks.requireCurrentProfile.mockResolvedValue(
      profile({ profile_photo_url: 'https://legacy.test/old.jpg' }),
    );

    const result = await uploadAvatarAction(null, formWith(jpegFile()));

    expect(result.ok).toBe(true);
    expect(updates[0]).toEqual({
      profile_photo_path: uploads[0]?.path,
      profile_photo_url: null,
    });
  });

  it('uploads before it updates the profile', async () => {
    await uploadAvatarAction(null, formWith(jpegFile()));

    // Order, not results. Updating first would leave the profile pointing at
    // an object that does not exist yet — a broken image for however long the
    // upload takes, and permanently if it fails.
    expect(mocks.trace).toEqual(['storage.upload', 'profiles.update']);
  });

  it('revalidates so the new face appears everywhere at once', async () => {
    await uploadAvatarAction(null, formWith(jpegFile()));

    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });
});

describe('replacing an existing managed avatar', () => {
  const previous = `${OWNER}/bbbbbbbb-0000-4000-8000-000000000002.jpg`;

  beforeEach(() => {
    mocks.requireCurrentProfile.mockResolvedValue(profile({ profile_photo_path: previous }));
  });

  it('deletes the previous object only after the profile update succeeds', async () => {
    await uploadAvatarAction(null, formWith(jpegFile()));

    expect(mocks.trace).toEqual(['storage.upload', 'profiles.update', 'storage.remove']);
    expect(removals[0]).toEqual({ bucket: 'avatars', paths: [previous] });
  });

  it('leaves the previous object alone when the profile update fails', async () => {
    mocks.update.mockResolvedValue({ error: { message: 'nope' } });

    const result = await uploadAvatarAction(null, formWith(jpegFile()));

    expect(result.ok).toBe(false);
    // The rollback deletes the *new* object. The old one is still what the
    // profile points at, so removing it would destroy a working avatar in
    // order to tidy up after a failure.
    expect(removals).toHaveLength(1);
    expect(removals[0]?.paths).toEqual([uploads[0]?.path]);
    expect(removals[0]?.paths).not.toContain(previous);
  });

  it('still reports success when the old object cannot be deleted', async () => {
    mocks.remove.mockResolvedValue({ error: { message: 'storage unreachable' } });

    const result = await uploadAvatarAction(null, formWith(jpegFile()));

    // The upload genuinely worked. Turning it into an error message because a
    // previous file could not be tidied away would be a lie about what
    // happened, and would invite the player to try again — uploading a second
    // object and orphaning a third.
    expect(result.ok).toBe(true);
    expect(mocks.logWarn).toHaveBeenCalledWith('avatar.cleanup_failed', { stage: 'previous' });
  });

  it('survives the storage client throwing during cleanup', async () => {
    mocks.remove.mockRejectedValue(new Error('socket hang up'));

    await expect(uploadAvatarAction(null, formWith(jpegFile()))).resolves.toMatchObject({
      ok: true,
    });
  });
});

describe('when the profile update fails', () => {
  beforeEach(() => {
    mocks.update.mockResolvedValue({ error: { message: 'constraint violation' } });
  });

  it('deletes the object it just uploaded', async () => {
    const result = await uploadAvatarAction(null, formWith(jpegFile()));

    expect(result.ok).toBe(false);
    expect(mocks.trace).toEqual(['storage.upload', 'profiles.update', 'storage.remove']);
    expect(removals[0]?.paths).toEqual([uploads[0]?.path]);
  });

  it('does not revalidate, because nothing changed', async () => {
    await uploadAvatarAction(null, formWith(jpegFile()));

    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('when the upload itself fails', () => {
  it('never touches the profile', async () => {
    mocks.upload.mockResolvedValue({ data: null, error: { message: 'bucket missing' } });

    const result = await uploadAvatarAction(null, formWith(jpegFile()));

    expect(result.ok).toBe(false);
    expect(updates).toHaveLength(0);
    expect(removals).toHaveLength(0);
  });
});

// ══ Removal ═══════════════════════════════════════════════════════════════

describe('removing an avatar', () => {
  const previous = `${OWNER}/cccccccc-0000-4000-8000-000000000003.jpg`;

  it('clears both columns before it deletes anything', async () => {
    mocks.requireCurrentProfile.mockResolvedValue(profile({ profile_photo_path: previous }));

    const result = await removeAvatarAction(null, new FormData());

    expect(result.ok).toBe(true);
    // The opposite order to an upload, for the same reason: deleting first
    // would, on a failed update, leave a profile pointing at a file that no
    // longer exists. A broken image is worse than an orphan nobody can find.
    expect(mocks.trace).toEqual(['profiles.update', 'storage.remove']);
    expect(updates[0]).toEqual({ profile_photo_path: null, profile_photo_url: null });
  });

  it('deletes nothing when the profile could not be cleared', async () => {
    mocks.requireCurrentProfile.mockResolvedValue(profile({ profile_photo_path: previous }));
    mocks.update.mockResolvedValue({ error: { message: 'nope' } });

    const result = await removeAvatarAction(null, new FormData());

    expect(result.ok).toBe(false);
    expect(removals).toHaveLength(0);
  });

  it('still reports success when the object cannot be deleted', async () => {
    mocks.requireCurrentProfile.mockResolvedValue(profile({ profile_photo_path: previous }));
    mocks.remove.mockResolvedValue({ error: { message: 'storage unreachable' } });

    const result = await removeAvatarAction(null, new FormData());

    expect(result.ok).toBe(true);
    expect(mocks.logWarn).toHaveBeenCalledWith('avatar.cleanup_failed', { stage: 'removed' });
  });
});

// ══ The legacy column is never a delete target ════════════════════════════

describe('a legacy external photo is cleared but never deleted', () => {
  const LEGACY = 'https://cdn.elsewhere.test/people/sam.jpg';

  it('sends nothing to storage when removing a legacy-only profile', async () => {
    mocks.requireCurrentProfile.mockResolvedValue(
      profile({ profile_photo_url: LEGACY, profile_photo_path: null }),
    );

    const result = await removeAvatarAction(null, new FormData());

    expect(result.ok).toBe(true);
    expect(updates[0]).toEqual({ profile_photo_path: null, profile_photo_url: null });
    // The decisive assertion of the two-column design. This product did not put
    // that file where it is and has no business asking Storage to delete
    // anything derived from it.
    expect(removals).toHaveLength(0);
  });

  it('sends nothing to storage when replacing a legacy-only profile', async () => {
    mocks.requireCurrentProfile.mockResolvedValue(
      profile({ profile_photo_url: LEGACY, profile_photo_path: null }),
    );

    await uploadAvatarAction(null, formWith(jpegFile()));

    expect(removals).toHaveLength(0);
    expect(mocks.trace).toEqual(['storage.upload', 'profiles.update']);
  });

  it('refuses to delete a stored path that does not belong to the caller', async () => {
    // Only reachable if a row were written outside `profiles_photo_path_shape`
    // — which is to say never. Asserted anyway, because "the constraint holds"
    // is not something the deletion path should be built on top of.
    mocks.requireCurrentProfile.mockResolvedValue(
      profile({ profile_photo_path: `${OTHER}/dddddddd-0000-4000-8000-000000000004.jpg` }),
    );

    await uploadAvatarAction(null, formWith(jpegFile()));

    expect(removals).toHaveLength(0);
  });

  it('refuses to delete a malformed stored path', async () => {
    for (const stored of [
      `${OWNER}/not-a-uuid.jpg`,
      `${OWNER}/../${OTHER}/x.jpg`,
      'https://cdn.elsewhere.test/x.jpg',
      `${OWNER}/`,
      '',
    ]) {
      removals.length = 0;
      mocks.requireCurrentProfile.mockResolvedValue(profile({ profile_photo_path: stored }));

      await removeAvatarAction(null, new FormData());

      expect(removals, stored).toHaveLength(0);
    }
  });
});

// ══ Logs ══════════════════════════════════════════════════════════════════

describe('nothing sensitive reaches the logs', () => {
  it('never logs the object path, the uuid or the user id', async () => {
    mocks.requireCurrentProfile.mockResolvedValue(
      profile({
        profile_photo_path: `${OWNER}/eeeeeeee-0000-4000-8000-000000000005.jpg`,
        profile_photo_url: 'https://cdn.elsewhere.test/sam.jpg',
      }),
    );
    mocks.remove.mockResolvedValue({ error: { message: 'boom' } });

    await uploadAvatarAction(null, formWith(jpegFile()));

    const logged = loggedText();
    // The path is a live public URL for anybody who reads the log stream.
    expect(logged).not.toContain(uploads[0]?.path ?? 'unreachable');
    expect(logged).not.toContain(OWNER);
    expect(logged).not.toContain('eeeeeeee-0000-4000-8000-000000000005');
    expect(logged).not.toContain('cdn.elsewhere.test');
  });

  it('never logs a name, an email or any file content', async () => {
    mocks.requireCurrentProfile.mockResolvedValue(
      profile({ first_name: 'Adaeze', last_name: 'Nwachukwu' }),
    );

    await uploadAvatarAction(null, formWith(jpegFile()));

    const logged = loggedText();
    expect(logged).not.toContain('Adaeze');
    expect(logged).not.toContain('Nwachukwu');
    expect(logged).not.toContain('JFIF');
  });

  it('records the size and whether a photo was replaced, and nothing else', async () => {
    await uploadAvatarAction(null, formWith(jpegFile(4096)));

    // Enough to notice "every upload is 40 bytes" or "nobody ever replaces
    // one" without identifying whose face it is.
    expect(mocks.logInfo).toHaveBeenCalledWith('avatar.uploaded', {
      bytes: 4096,
      replaced: false,
    });
  });

  it('emits only fields the log filter actually writes', async () => {
    const { assertLoggable } = await import('@/lib/observability/log');
    mocks.remove.mockResolvedValue({ error: { message: 'boom' } });
    mocks.requireCurrentProfile.mockResolvedValue(
      profile({ profile_photo_path: `${OWNER}/ffffffff-0000-4000-8000-000000000006.jpg` }),
    );

    await uploadAvatarAction(null, formWith(jpegFile()));
    await removeAvatarAction(null, new FormData());

    const calls = [
      ...mocks.logInfo.mock.calls,
      ...mocks.logWarn.mock.calls,
      ...mocks.logError.mock.calls,
    ];
    expect(calls.length).toBeGreaterThan(0);
    for (const [event, fields] of calls) {
      // A field silently dropped by the key denylist is this logger's
      // characteristic failure mode — `stage` and `bytes` must survive it.
      expect(assertLoggable(fields as ObservabilityLog.LogFields), String(event)).toBe(true);
    }
  });
});

// ══ What the caller is told ═══════════════════════════════════════════════

describe('the result shape', () => {
  it('reports a validation failure against the picker own field', async () => {
    const result = await uploadAvatarAction(null, formWith(jpegFile(512, 'image/png')));

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    if (!result.ok) {
      expect(typeof result.fieldErrors['avatar']).toBe('string');
    }
  });

  it('says nothing about internal state on failure', async () => {
    mocks.upload.mockResolvedValue({
      data: null,
      error: { message: 'row-level security policy violation on storage.objects for user 1111' },
    });

    const result = await uploadAvatarAction(null, formWith(jpegFile()));

    expect(JSON.stringify(result)).not.toContain('row-level security');
    expect(JSON.stringify(result)).not.toContain('storage.objects');
  });
});

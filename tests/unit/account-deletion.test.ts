import { describe, expect, it, vi } from 'vitest';
import { isPushEligible, buildPushPayload } from '@/lib/push/payload';
import type { NotificationType } from '@/types/database';

/**
 * The parts of account deletion that are not a database transaction.
 *
 * `deleteAvatarObjects` is the one step whose failure must stop everything, so
 * its behaviour on partial success and on pagination is the point: a silent
 * "removed 100 of 143" would let the scrub proceed and stamp `deleted_at` — a
 * row that promises no personal data remains — while forty-three faces were
 * still being served from public URLs.
 */

const mocks = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  isServiceRoleConfigured: vi.fn(() => true),
  deleteUser: vi.fn(),
}));

vi.mock('@/lib/observability/log', () => ({
  logInfo: mocks.logInfo,
  logWarn: mocks.logWarn,
  logError: mocks.logError,
}));

vi.mock('@/lib/supabase/admin', () => ({
  isServiceRoleConfigured: mocks.isServiceRoleConfigured,
  createSupabaseAdminClient: () => ({ auth: { admin: { deleteUser: mocks.deleteUser } } }),
}));

const { deleteAvatarObjects, deleteAuthUser, finalizeAndDeleteAuth } = await import(
  '@/lib/account/deletion'
);

const USER = '11111111-1111-4111-8111-000000000003';

/**
 * A Storage double that answers `list` from a fixed set of object names.
 *
 * Paginates exactly as Supabase does — 100 per page — so a caller that forgets
 * to loop reads the first hundred and believes it is finished.
 */
function storageDouble(options: {
  names: string[];
  removed?: (names: string[]) => string[];
  listError?: string;
  removeError?: string;
}) {
  const removeCalls: string[][] = [];

  const client = {
    storage: {
      from: (bucket: string) => {
        expect(bucket).toBe('avatars');
        return {
          list: (prefix: string, { limit, offset }: { limit: number; offset: number }) => {
            expect(prefix).toBe(USER);
            if (options.listError !== undefined) {
              return Promise.resolve({ data: null, error: { message: options.listError } });
            }
            const page = options.names
              .slice(offset, offset + limit)
              .map((name) => ({ id: `id-${name}`, name }));
            return Promise.resolve({ data: page, error: null });
          },
          remove: (names: string[]) => {
            removeCalls.push(names);
            if (options.removeError !== undefined) {
              return Promise.resolve({ data: null, error: { message: options.removeError } });
            }
            const removed = options.removed?.(names) ?? names;
            return Promise.resolve({ data: removed.map((name) => ({ name })), error: null });
          },
        };
      },
    },
  };

  return { client, removeCalls };
}

describe('deleteAvatarObjects', () => {
  it('deletes every object in the folder, not just the one the profile names', async () => {
    // The stale-object case. Each upload writes a new uuid and the previous
    // object is cleaned up afterwards with failures swallowed, so a folder can
    // hold several while the profile points at one.
    const { client, removeCalls } = storageDouble({
      names: ['a.jpg', 'b.jpg', 'c.jpg'],
    });

    const result = await deleteAvatarObjects(client as never, USER);

    expect(result).toEqual({ found: 3, removed: 3 });
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]).toEqual([`${USER}/a.jpg`, `${USER}/b.jpg`, `${USER}/c.jpg`]);
  });

  it('pages past the hundred-object limit', async () => {
    // Somebody who changed their photo weekly for two years. A single
    // unpaginated `list` would leave the remainder behind, and the failure mode
    // is silence.
    const names = Array.from({ length: 143 }, (_, index) => `avatar-${String(index)}.jpg`);
    const { client, removeCalls } = storageDouble({ names });

    const result = await deleteAvatarObjects(client as never, USER);

    expect(result.found).toBe(143);
    expect(removeCalls[0]).toHaveLength(143);
  });

  it('does nothing when the folder is already empty', async () => {
    const { client, removeCalls } = storageDouble({ names: [] });

    await expect(deleteAvatarObjects(client as never, USER)).resolves.toEqual({
      found: 0,
      removed: 0,
    });
    expect(removeCalls).toHaveLength(0);
  });

  it('throws when Storage removed only some of them', async () => {
    // A PARTIAL REMOVAL IS A FAILURE. Reporting success here would let the
    // caller stamp `deleted_at` while an image was still public.
    const { client } = storageDouble({
      names: ['a.jpg', 'b.jpg', 'c.jpg'],
      removed: (names) => names.slice(0, 2),
    });

    await expect(deleteAvatarObjects(client as never, USER)).rejects.toThrow(/2 of 3/);
  });

  it('throws when the listing fails', async () => {
    const { client } = storageDouble({ names: [], listError: 'network down' });
    await expect(deleteAvatarObjects(client as never, USER)).rejects.toThrow(/list avatar objects/);
  });

  it('throws when the removal fails outright', async () => {
    const { client } = storageDouble({ names: ['a.jpg'], removeError: 'nope' });
    await expect(deleteAvatarObjects(client as never, USER)).rejects.toThrow(
      /delete avatar objects/,
    );
  });

  it('never puts an object key in a log', async () => {
    const { client } = storageDouble({ names: ['a.jpg'] });
    await deleteAvatarObjects(client as never, USER);

    // An object key is a live public URL. Counts only.
    for (const call of mocks.logInfo.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('.jpg');
    }
  });
});

describe('deleteAuthUser', () => {
  it('reports success when GoTrue deletes the row', async () => {
    mocks.deleteUser.mockResolvedValue({ error: null });
    await expect(deleteAuthUser(USER)).resolves.toBe(true);
  });

  it('treats an already-missing user as done', async () => {
    // Both the retry and the reconciler can arrive after somebody else
    // finished. Treating 404 as failure would leave the account permanently
    // unfinished and permanently retried.
    mocks.deleteUser.mockResolvedValue({ error: { status: 404, message: 'not found' } });
    await expect(deleteAuthUser(USER)).resolves.toBe(true);
  });

  it('reports failure at operator severity, with no email in the payload', async () => {
    mocks.logError.mockClear();
    mocks.deleteUser.mockResolvedValue({ error: { status: 500, message: 'boom' } });

    await expect(deleteAuthUser(USER)).resolves.toBe(false);

    const call = mocks.logError.mock.calls.at(-1);
    expect(call?.[0]).toBe('account_deletion.auth_delete_failed');
    expect(call?.[1]).toMatchObject({ severity: 'unexpected' });
    // THE STATE THIS LOG DESCRIBES is one where auth.users still holds the real
    // address. Logging it here would be the one place it leaked.
    expect(JSON.stringify(call)).not.toContain('@');
  });

  it('never throws, whatever GoTrue does', async () => {
    mocks.deleteUser.mockRejectedValue(new Error('socket hang up'));
    await expect(deleteAuthUser(USER)).resolves.toBe(false);
  });

  it('refuses without a service-role key rather than pretending', async () => {
    mocks.isServiceRoleConfigured.mockReturnValueOnce(false);
    await expect(deleteAuthUser(USER)).resolves.toBe(false);
  });
});

describe('finalizeAndDeleteAuth', () => {
  it('reports auth_pending when the identity outlives the scrub', async () => {
    // The state that looks finished and is not: MatchDay is anonymous, GoTrue
    // still holds the address.
    mocks.deleteUser.mockResolvedValue({ error: { status: 500, message: 'boom' } });

    await expect(finalizeAndDeleteAuth(async () => undefined, USER)).resolves.toBe('auth_pending');
  });

  it('reports complete when both halves are done', async () => {
    mocks.deleteUser.mockResolvedValue({ error: null });
    await expect(finalizeAndDeleteAuth(async () => undefined, USER)).resolves.toBe('complete');
  });

  it('does not touch Auth when the scrub itself failed', async () => {
    // Ordering is the safety property: Auth must never go first, or the account
    // becomes unreachable while its name is still on every roster.
    mocks.deleteUser.mockClear();

    await expect(
      finalizeAndDeleteAuth(async () => {
        throw new Error('scrub failed');
      }, USER),
    ).rejects.toThrow('scrub failed');

    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });
});

describe('league_closed is in-app only', () => {
  it('is not push-eligible', () => {
    expect(isPushEligible('league_closed' as NotificationType)).toBe(false);
  });

  it('builds no push payload at all', () => {
    // The stronger statement: the dispatcher skips anything this returns null
    // for, so there is nothing to send rather than something suppressed.
    expect(
      buildPushPayload({
        id: '11111111-1111-4111-8111-000000000001',
        type: 'league_closed' as NotificationType,
        title: 'League closed',
        body: 'Weeknight 5v5 has been closed.',
        deep_link: '/dashboard',
      }),
    ).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the deletion action does about the session, and why it depends on the
 * outcome.
 *
 * ── THE BUG THIS PINS ──────────────────────────────────────────────────────
 *
 * The action used to sign out unconditionally, reasoning that the account is
 * unusable either way. It is — but when the Auth row survives, `auth.users`
 * still holds the person's real email address, so the deletion is genuinely
 * unfinished, and finishing it from the interface means pressing "Finish
 * deleting account" on the status page. That retry resolves the account from
 * the session.
 *
 * Signing out therefore removed the only thing that made the retry possible,
 * and left somebody reading "Your account was deleted" — which was not true —
 * with nothing they could do about it. If the service role is what failed, the
 * cron reconciler cannot rescue them either, because it needs the same key.
 *
 * CI found this the hard way: the E2E job ran a server with no
 * `SUPABASE_SERVICE_ROLE_KEY`, every deletion ended `auth_pending`, and the
 * product reported success.
 */

const mocks = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(readonly path: string) {
      super(`NEXT_REDIRECT;${path}`);
      this.name = 'RedirectSignal';
    }
  }

  return {
    RedirectSignal,
    redirect: vi.fn((path: string): never => {
      throw new RedirectSignal(path);
    }),
    revalidatePath: vi.fn(),
    getSessionUser: vi.fn(),
    rpc: vi.fn(),
    signOut: vi.fn(),
    deleteAvatarObjects: vi.fn(),
    finalizeAndDeleteAuth: vi.fn(),
    signInWithPassword: vi.fn(),
  };
});

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: mocks.getSessionUser,
  requireSessionUser: vi.fn(),
  getCurrentProfile: vi.fn(),
  isProfileDeleting: () => false,
}));
vi.mock('@/lib/account/deletion', () => ({
  deleteAvatarObjects: mocks.deleteAvatarObjects,
  finalizeAndDeleteAuth: mocks.finalizeAndDeleteAuth,
}));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    rpc: mocks.rpc,
    auth: {
      signOut: mocks.signOut,
      signInWithPassword: mocks.signInWithPassword,
    },
  }),
}));

const { deleteAccountAction, retryAccountDeletionAction } = await import(
  '@/server/actions/account'
);

const USER = { id: '11111111-1111-4111-8111-000000000003', email: 'player@matchday.test' };

function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set('method', 'password');
  data.set('password', 'correct-horse-battery');
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

/** Runs the action and reports where it redirected, if it did. */
async function run(action: () => Promise<unknown>): Promise<string | null> {
  try {
    await action();
  } catch (error: unknown) {
    if (error instanceof mocks.RedirectSignal) {
      return error.path;
    }
    throw error;
  }
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUser.mockResolvedValue(USER);
  mocks.rpc.mockResolvedValue({ error: null });
  mocks.signInWithPassword.mockResolvedValue({ error: null });
  mocks.deleteAvatarObjects.mockResolvedValue({ found: 0, removed: 0 });
  mocks.signOut.mockResolvedValue({ error: null });
});

describe('deleteAccountAction', () => {
  it('signs out once the Auth identity is gone', async () => {
    mocks.finalizeAndDeleteAuth.mockResolvedValue('complete');

    expect(await run(() => deleteAccountAction(null, form()))).toBe('/account/deleted');
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });

  it('keeps the session when the Auth identity outlived the scrub', async () => {
    // Otherwise the retry on the status page has no account to resolve, and the
    // deletion can only ever be finished by a background job.
    mocks.finalizeAndDeleteAuth.mockResolvedValue('auth_pending');

    expect(await run(() => deleteAccountAction(null, form()))).toBe('/account/deleted');
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('empties the avatar folder before the scrub, never after', async () => {
    const order: string[] = [];
    mocks.deleteAvatarObjects.mockImplementation(async () => {
      order.push('storage');
      return { found: 1, removed: 1 };
    });
    mocks.finalizeAndDeleteAuth.mockImplementation(async (finalize: () => Promise<void>) => {
      order.push('finalize');
      await finalize();
      return 'complete';
    });

    await run(() => deleteAccountAction(null, form()));

    // A `deleted_at` stamped while an image is still public would be the row
    // promising something untrue.
    expect(order).toEqual(['storage', 'finalize']);
  });

  it('stops before the scrub when Storage cleanup fails', async () => {
    mocks.deleteAvatarObjects.mockRejectedValue(new Error('storage unreachable'));

    const result = await deleteAccountAction(null, form());

    expect(result?.ok).toBe(false);
    expect(mocks.finalizeAndDeleteAuth).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('never begins when re-authentication fails', async () => {
    mocks.signInWithPassword.mockResolvedValue({ error: { message: 'Invalid credentials' } });

    const result = await deleteAccountAction(null, form());

    expect(result?.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.deleteAvatarObjects).not.toHaveBeenCalled();
  });
});

describe('retryAccountDeletionAction', () => {
  it('signs out only once the Auth identity is gone', async () => {
    mocks.finalizeAndDeleteAuth.mockResolvedValue('complete');

    expect(await run(() => retryAccountDeletionAction(null, new FormData()))).toBe(
      '/account/deleted',
    );
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });

  it('leaves the session alone so a further retry is still possible', async () => {
    mocks.finalizeAndDeleteAuth.mockResolvedValue('auth_pending');

    expect(await run(() => retryAccountDeletionAction(null, new FormData()))).toBe(
      '/account/deleted',
    );
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('asks for no proof of identity, because starting already required it', async () => {
    mocks.finalizeAndDeleteAuth.mockResolvedValue('complete');

    await run(() => retryAccountDeletionAction(null, new FormData()));

    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });
});

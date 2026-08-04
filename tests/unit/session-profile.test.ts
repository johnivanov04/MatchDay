import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getCurrentProfile()` must distinguish two outcomes that look alike:
 *
 *   * `data: null, error: null`  — no profile row yet. An ordinary onboarding
 *     state; the caller redirects to /onboarding.
 *   * `error: <something>`       — the query failed. Must surface.
 *
 * Collapsing the second into the first would route every signed-in user to
 * /onboarding during a database outage and invite them to re-create a profile
 * they already have.
 */

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: mocks.maybeSingle }),
      }),
    }),
  }),
}));

const { getCurrentProfile, getSessionUser } = await import('@/lib/auth/session');

const AUTH_USER = {
  data: { user: { id: 'user-1', email: 'Player.Multi@Matchday.test' } },
  error: null,
};

const PROFILE_ROW = {
  id: 'user-1',
  first_name: 'Jules',
  last_name: 'Okonkwo',
  email_normalized: 'player.multi@matchday.test',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getSessionUser', () => {
  it('returns null when there is no session', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it('returns null when the auth server reports an error', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad jwt' } });
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it('normalises the email case of a valid session', async () => {
    mocks.getUser.mockResolvedValue(AUTH_USER);
    await expect(getSessionUser()).resolves.toEqual({
      id: 'user-1',
      email: 'player.multi@matchday.test',
    });
  });
});

describe('getCurrentProfile', () => {
  it('returns null for a signed-in user who has not onboarded', async () => {
    mocks.getUser.mockResolvedValue(AUTH_USER);
    // maybeSingle() reports "no row" as data: null with no error.
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(getCurrentProfile()).resolves.toBeNull();
  });

  it('returns the profile once onboarding is complete', async () => {
    mocks.getUser.mockResolvedValue(AUTH_USER);
    mocks.maybeSingle.mockResolvedValue({ data: PROFILE_ROW, error: null });

    await expect(getCurrentProfile()).resolves.toEqual(PROFILE_ROW);
  });

  it('throws when the profile query genuinely fails', async () => {
    mocks.getUser.mockResolvedValue(AUTH_USER);
    mocks.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'connection terminated unexpectedly' },
    });

    await expect(getCurrentProfile()).rejects.toThrow('connection terminated unexpectedly');
  });

  it('returns null without querying when there is no session', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    await expect(getCurrentProfile()).resolves.toBeNull();
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
  });
});

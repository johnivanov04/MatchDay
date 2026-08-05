import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression tests for the post-transfer navigation bug.
 *
 * `transferAdministrationAction` is invoked from `/leagues/[slug]/members`, a
 * route the caller stops being entitled to the instant the transfer commits.
 * Returning success and revalidating would re-render that forbidden route
 * inside the action's own response, so the action must navigate away instead.
 *
 * Two orderings are asserted, because both were wrong before:
 *   * `revalidatePath` before `redirect`, so the destination renders from
 *     fresh membership data;
 *   * `redirect` outside the try/catch, since it signals by throwing and
 *     `actionFailure` would otherwise swallow it into a generic failure.
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
    requireLeagueAdmin: vi.fn(),
    requireSessionUser: vi.fn(),
    rpc: vi.fn(),
  };
});

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/auth/authorization', () => ({
  requireLeagueAdmin: mocks.requireLeagueAdmin,
  getMyMemberships: vi.fn(),
}));
vi.mock('@/lib/auth/session', () => ({
  requireSessionUser: mocks.requireSessionUser,
  getSessionUser: vi.fn(),
  getCurrentProfile: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    rpc: mocks.rpc,
    from: () => ({ update: () => ({ eq: () => ({ eq: () => ({ error: null }) }) }) }),
  }),
}));

const { transferAdministrationAction } = await import('@/server/actions/membership');
const { DASHBOARD_NOTICES, dashboardPathWithNotice } = await import('@/lib/auth/page-guards');

const LEAGUE_ID = '22222222-2222-4222-8222-000000000001';
const MEMBERSHIP_ID = '33333333-3333-4333-8333-000000000003';

function transferForm(overrides: Record<string, string> = {}): FormData {
  const formData = new FormData();
  formData.set('league_id', LEAGUE_ID);
  formData.set('membership_id', MEMBERSHIP_ID);
  formData.set('confirm', 'transfer');
  formData.set('reason', 'Stepping down');
  for (const [key, value] of Object.entries(overrides)) {
    formData.set(key, value);
  }
  return formData;
}

/** Runs the action and reports the redirect it performed, if any. */
async function runTransfer(formData: FormData) {
  try {
    const result = await transferAdministrationAction(null, formData);
    return { redirectedTo: null as string | null, result };
  } catch (error: unknown) {
    if (error instanceof mocks.RedirectSignal) {
      return { redirectedTo: error.path, result: null };
    }
    throw error;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireLeagueAdmin.mockResolvedValue({});
  mocks.requireSessionUser.mockResolvedValue({ id: 'user-1', email: 'a@matchday.test' });
  mocks.rpc.mockResolvedValue({ data: null, error: null });
});

describe('a successful transfer', () => {
  it('redirects the former administrator to the dashboard', async () => {
    const { redirectedTo, result } = await runTransfer(transferForm());

    expect(redirectedTo).toBe(
      dashboardPathWithNotice(DASHBOARD_NOTICES.administrationTransferred),
    );
    expect(redirectedTo).toContain('/dashboard');
    // It must navigate, not return success and re-render the members route.
    expect(result).toBeNull();
  });

  it('revalidates before redirecting, so the dashboard sees the new role', async () => {
    await runTransfer(transferForm());

    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout');
    expect(mocks.revalidatePath.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.redirect.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('performs the transfer through the single atomic RPC', async () => {
    await runTransfer(transferForm());

    // One statement, one transaction — the atomicity requirement is a property
    // of calling this function and nothing else.
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('transfer_league_administration', {
      p_league_id: LEAGUE_ID,
      p_target_membership_id: MEMBERSHIP_ID,
      p_reason: 'Stepping down',
    });
  });

  it('does not surface NOT_LEAGUE_ADMIN to the caller', async () => {
    const { redirectedTo } = await runTransfer(transferForm());
    expect(redirectedTo).not.toContain('NOT_LEAGUE_ADMIN');
  });
});

describe('a failed transfer', () => {
  it('does not redirect when the database refuses', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: 'ADMIN_TRANSFER_INVALID: the recipient must be an active player' },
    });

    const { redirectedTo, result } = await runTransfer(transferForm());

    // The caller is still an administrator on a page they may view, so the
    // error belongs in the form rather than in a navigation.
    expect(redirectedTo).toBeNull();
    expect(result?.ok).toBe(false);
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('reports ADMIN_TRANSFER_INVALID without leaking the database message', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: {
        message:
          'ADMIN_TRANSFER_INVALID: membership 3333… in league 2222… is not an active player',
      },
    });

    const { result } = await runTransfer(transferForm());

    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      expect(result.code).toBe('ADMIN_TRANSFER_INVALID');
      expect(JSON.stringify(result)).not.toContain('membership 3333');
    }
  });

  it('refuses without the typed confirmation, and never calls the database', async () => {
    const { redirectedTo, result } = await runTransfer(transferForm({ confirm: '' }));

    expect(redirectedTo).toBeNull();
    expect(result?.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('refuses when the caller is not the administrator', async () => {
    const { DomainError } = await import('@/lib/errors');
    mocks.requireLeagueAdmin.mockRejectedValue(new DomainError('NOT_LEAGUE_ADMIN'));

    const { redirectedTo, result } = await runTransfer(transferForm());

    expect(redirectedTo).toBeNull();
    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      expect(result.code).toBe('NOT_LEAGUE_ADMIN');
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('refuses a malformed membership id before reaching the database', async () => {
    const { redirectedTo, result } = await runTransfer(
      transferForm({ membership_id: 'not-a-uuid' }),
    );

    expect(redirectedTo).toBeNull();
    expect(result?.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

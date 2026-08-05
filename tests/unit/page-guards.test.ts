import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileRow } from '@/types/database';

function walkTypeScript(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = join(directory, entry);
    return statSync(fullPath).isDirectory()
      ? walkTypeScript(fullPath)
      : /\.tsx?$/.test(fullPath)
        ? [fullPath]
        : [];
  });
}

/**
 * Route-guard behaviour for the onboarding flow.
 *
 * The distinction under test is what *kind* of throw each outcome produces.
 * `redirect()` throws `NEXT_REDIRECT`, a control-flow signal Next.js handles
 * silently; anything else escaping a render is logged as an application error
 * with a full stack. An un-onboarded user is an expected state and must produce
 * the former, while a database failure must still produce the latter.
 */

const mocks = vi.hoisted(() => {
  /** Stands in for the `NEXT_REDIRECT` signal that `redirect()` throws. */
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
    getSessionUser: vi.fn(),
    getCurrentProfile: vi.fn(),
    findMyLeagueBySlug: vi.fn(),
  };
});

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: mocks.getSessionUser,
  getCurrentProfile: mocks.getCurrentProfile,
}));
vi.mock('@/lib/leagues/league-admin', () => ({
  findMyLeagueBySlug: mocks.findMyLeagueBySlug,
}));

const {
  DASHBOARD_NOTICES,
  DASHBOARD_PATH,
  ONBOARDING_PATH,
  SIGN_IN_PATH,
  dashboardPathWithNotice,
  parseDashboardNotice,
  requireLeagueAdminPage,
  requireOnboardedUser,
  requireOnboardingCandidate,
  requireSignedInUser,
} = await import('@/lib/auth/page-guards');

const SESSION_USER = { id: 'user-1', email: 'player.multi@matchday.test' };
const PROFILE = {
  id: 'user-1',
  first_name: 'Jules',
  last_name: 'Okonkwo',
  email_normalized: 'player.multi@matchday.test',
} as ProfileRow;

/** Captures the redirect a guard performed, failing if it did not redirect. */
async function expectRedirect(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof mocks.RedirectSignal) {
      return error.path;
    }
    throw error;
  }
  throw new Error('Expected the guard to redirect, but it returned normally.');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireSignedInUser', () => {
  it('redirects an unauthenticated visitor to sign-in', async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    expect(await expectRedirect(requireSignedInUser)).toBe(SIGN_IN_PATH);
    expect(SIGN_IN_PATH).toBe('/sign-in');
  });

  it('returns the user when a session exists', async () => {
    mocks.getSessionUser.mockResolvedValue(SESSION_USER);

    await expect(requireSignedInUser()).resolves.toEqual(SESSION_USER);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe('requireOnboardedUser', () => {
  it('redirects an unauthenticated visitor to sign-in', async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    expect(await expectRedirect(requireOnboardedUser)).toBe('/sign-in');
    // The profile is never queried without a session.
    expect(mocks.getCurrentProfile).not.toHaveBeenCalled();
  });

  it('redirects an authenticated user with no profile to onboarding', async () => {
    mocks.getSessionUser.mockResolvedValue(SESSION_USER);
    mocks.getCurrentProfile.mockResolvedValue(null);

    expect(await expectRedirect(requireOnboardedUser)).toBe(ONBOARDING_PATH);
    expect(ONBOARDING_PATH).toBe('/onboarding');
  });

  it('does not raise an application error for the un-onboarded state', async () => {
    // The regression this whole change exists for: an incomplete profile threw
    // DomainError('PROFILE_INCOMPLETE') during render, which Next.js logged as
    // an unhandled error even though the redirect itself was correct.
    mocks.getSessionUser.mockResolvedValue(SESSION_USER);
    mocks.getCurrentProfile.mockResolvedValue(null);

    const error = await requireOnboardedUser().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(mocks.RedirectSignal);
    expect((error as Error).message).toContain('NEXT_REDIRECT');
    expect((error as Error).message).not.toContain('PROFILE_INCOMPLETE');
  });

  it('returns the user and profile when onboarding is complete', async () => {
    mocks.getSessionUser.mockResolvedValue(SESSION_USER);
    mocks.getCurrentProfile.mockResolvedValue(PROFILE);

    await expect(requireOnboardedUser()).resolves.toEqual({
      user: SESSION_USER,
      profile: PROFILE,
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('lets a genuine database failure surface instead of redirecting', async () => {
    mocks.getSessionUser.mockResolvedValue(SESSION_USER);
    mocks.getCurrentProfile.mockRejectedValue(new Error('connection terminated unexpectedly'));

    await expect(requireOnboardedUser()).rejects.toThrow('connection terminated unexpectedly');
    // A real outage must not be mistaken for "this user has not onboarded".
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe('requireOnboardingCandidate', () => {
  it('redirects an unauthenticated visitor to sign-in', async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    expect(await expectRedirect(requireOnboardingCandidate)).toBe('/sign-in');
  });

  it('sends an already-onboarded user to the dashboard', async () => {
    mocks.getSessionUser.mockResolvedValue(SESSION_USER);
    mocks.getCurrentProfile.mockResolvedValue(PROFILE);

    expect(await expectRedirect(requireOnboardingCandidate)).toBe(DASHBOARD_PATH);
    expect(DASHBOARD_PATH).toBe('/dashboard');
  });

  it('lets a user with no profile stay and complete onboarding', async () => {
    mocks.getSessionUser.mockResolvedValue(SESSION_USER);
    mocks.getCurrentProfile.mockResolvedValue(null);

    await expect(requireOnboardingCandidate()).resolves.toEqual(SESSION_USER);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe('requireLeagueAdminPage', () => {
  const league = { id: 'league-1', slug: 'sunday-futsal', name: 'Sunday Futsal' };

  function membership(role: 'league_admin' | 'player', status = 'active') {
    return { league, membership: { id: 'm-1', league_id: league.id, role, status } };
  }

  beforeEach(() => {
    mocks.getSessionUser.mockResolvedValue(SESSION_USER);
    mocks.getCurrentProfile.mockResolvedValue(PROFILE);
  });

  it('lets the league administrator through', async () => {
    mocks.findMyLeagueBySlug.mockResolvedValue(membership('league_admin'));

    const result = await requireLeagueAdminPage('sunday-futsal');

    expect(result.league).toEqual(league);
    expect(result.user).toEqual(SESSION_USER);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('redirects a player to the dashboard instead of throwing', async () => {
    // The regression this exists for: a thrown DomainError here surfaces as an
    // unhandled Next.js error, because it escapes a Server Component render.
    mocks.findMyLeagueBySlug.mockResolvedValue(membership('player'));

    const path = await expectRedirect(() => requireLeagueAdminPage('sunday-futsal'));

    expect(path).toBe(dashboardPathWithNotice(DASHBOARD_NOTICES.notLeagueAdmin));
    expect(path.startsWith(DASHBOARD_PATH)).toBe(true);
  });

  it('redirects a former administrator once they hold a player membership', async () => {
    // Exactly the post-transfer state: still on the members route, no longer
    // entitled to it.
    mocks.findMyLeagueBySlug.mockResolvedValue(membership('player'));

    const error = await requireLeagueAdminPage('sunday-futsal').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(mocks.RedirectSignal);
    expect((error as Error).message).toContain('NEXT_REDIRECT');
    expect((error as Error).message).not.toContain('NOT_LEAGUE_ADMIN');
  });

  it.each([
    ['suspended', 'league_admin'],
    ['pending', 'league_admin'],
    ['removed', 'league_admin'],
  ])('redirects an administrator whose membership is %s', async (status, role) => {
    mocks.findMyLeagueBySlug.mockResolvedValue(
      membership(role as 'league_admin', status),
    );

    const path = await expectRedirect(() => requireLeagueAdminPage('sunday-futsal'));
    expect(path).toBe(dashboardPathWithNotice(DASHBOARD_NOTICES.notLeagueAdmin));
  });

  it('gives an unknown slug the same answer as a league the caller only plays in', async () => {
    // A distinguishable response would let anyone probe for private leagues by
    // guessing slugs.
    mocks.findMyLeagueBySlug.mockResolvedValue(null);
    const unknown = await expectRedirect(() => requireLeagueAdminPage('does-not-exist'));

    mocks.findMyLeagueBySlug.mockResolvedValue(membership('player'));
    const notAdmin = await expectRedirect(() => requireLeagueAdminPage('sunday-futsal'));

    expect(unknown).toBe(notAdmin);
  });

  it('sends an unauthenticated visitor to sign-in, not to the dashboard', async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    expect(await expectRedirect(() => requireLeagueAdminPage('sunday-futsal'))).toBe(SIGN_IN_PATH);
    expect(mocks.findMyLeagueBySlug).not.toHaveBeenCalled();
  });

  it('lets a genuine failure surface rather than redirecting', async () => {
    mocks.findMyLeagueBySlug.mockRejectedValue(new Error('connection terminated unexpectedly'));

    await expect(requireLeagueAdminPage('sunday-futsal')).rejects.toThrow(
      'connection terminated unexpectedly',
    );
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe('dashboard notices', () => {
  it('accepts only known codes', () => {
    expect(parseDashboardNotice(DASHBOARD_NOTICES.notLeagueAdmin)).toBe(
      DASHBOARD_NOTICES.notLeagueAdmin,
    );
    expect(parseDashboardNotice(DASHBOARD_NOTICES.administrationTransferred)).toBe(
      DASHBOARD_NOTICES.administrationTransferred,
    );
  });

  it.each([
    ['made-up-code'],
    ['<script>alert(1)</script>'],
    [''],
    [null],
    [undefined],
    [42],
    [['not-league-admin']],
  ])('rejects %s', (candidate) => {
    // The notice only chooses a sentence, but an unvalidated value would still
    // reach the DOM as a lookup key.
    expect(parseDashboardNotice(candidate)).toBeNull();
  });
});

describe('redirect-loop protection', () => {
  const repoRoot = new URL('../../', import.meta.url).pathname;

  it('keeps /onboarding outside the (app) route group', () => {
    // `(app)/layout.tsx` redirects an un-onboarded user to /onboarding. If that
    // page lived inside the group it would re-enter the same guard and loop.
    expect(existsSync(join(repoRoot, 'src/app/onboarding/page.tsx'))).toBe(true);
    expect(existsSync(join(repoRoot, 'src/app/(app)/onboarding'))).toBe(false);
  });

  it('uses no throwing profile helper anywhere under src/app', () => {
    // The original defect: a page called `requireCurrentProfile()`, which throws
    // DomainError('PROFILE_INCOMPLETE'). Because a layout and its page render
    // concurrently, the layout's redirect did not prevent that throw, and Next
    // logged it as an unhandled application error. Pages must express the
    // un-onboarded state as a redirect instead.
    const appDir = join(repoRoot, 'src/app');
    const offenders = walkTypeScript(appDir).filter((file) =>
      readFileSync(file, 'utf8').includes('requireCurrentProfile'),
    );

    expect(offenders.map((file) => relative(repoRoot, file))).toEqual([]);
  });

  it('never lets the two onboarding guards redirect to each other’s page', () => {
    // requireOnboardedUser sends "no profile" to /onboarding;
    // requireOnboardingCandidate sends "has profile" to /dashboard.
    // The conditions are exact complements, so no request satisfies both.
    expect(ONBOARDING_PATH).not.toBe(DASHBOARD_PATH);
    expect(ONBOARDING_PATH).not.toBe(SIGN_IN_PATH);
  });
});

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
  };
});

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/auth/session', () => ({
  getSessionUser: mocks.getSessionUser,
  getCurrentProfile: mocks.getCurrentProfile,
}));

const {
  DASHBOARD_PATH,
  ONBOARDING_PATH,
  SIGN_IN_PATH,
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

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Release-readiness checks that do not need a browser.
 *
 * ── WHY THESE ARE SOURCE ASSERTIONS ────────────────────────────────────────
 *
 * The end-to-end spec proves the pages render and that a signed-out visitor can
 * reach them. What it cannot cheaply prove is *placement* — that these three
 * files live outside the authenticated route group, which is the single
 * structural fact that makes them public. A page moved into `(app)` would still
 * pass every rendering assertion when the suite happens to be signed in, and
 * fail in an App Store reviewer's browser.
 *
 * The rest guard wording that has to keep matching the implementation.
 */

const read = (path: string): string => readFileSync(path, 'utf8');

/**
 * The file with its comments removed.
 *
 * The placement assertions below ask whether a page *calls* a guard, and these
 * files explain in prose why they do not — so a raw substring search finds the
 * explanation and fails. Stripping comments makes the assertion mean what it
 * says, and keeps the comments worth writing.
 */
function codeOf(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const PRIVACY = 'src/app/(legal)/privacy/page.tsx';
const TERMS = 'src/app/(legal)/terms/page.tsx';
const SUPPORT = 'src/app/(legal)/support/page.tsx';
const PROFILE = 'src/app/(app)/profile/page.tsx';

describe('the public pages are outside the authenticated group', () => {
  it.each([PRIVACY, TERMS, SUPPORT])('%s exists where it is publicly routable', (path) => {
    expect(() => read(path)).not.toThrow();
  });

  it.each([PRIVACY, TERMS, SUPPORT])('%s performs no session or profile lookup', (path) => {
    const source = codeOf(path);

    // Any of these would make the page depend on being signed in — and the
    // guards among them would redirect a reviewer to /sign-in.
    for (const forbidden of [
      'requireOnboardedUser',
      'requireSignedInUser',
      'requireSessionUser',
      'getSessionUser',
      'getCurrentProfile',
      'requireCurrentProfile',
    ]) {
      expect(source, `${path} calls ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the legal layout does not guard either', () => {
    // Named guards rather than the words "require" or "redirect", which appear
    // in the prose explaining why this layout has neither.
    const source = codeOf('src/app/(legal)/layout.tsx');
    for (const forbidden of [
      'requireOnboardedUser',
      'requireSignedInUser',
      'getSessionUser',
      'getCurrentProfile',
      "from 'next/navigation'",
    ]) {
      expect(source, `the legal layout uses ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('the Profile screen links to all three', () => {
  const profile = read(PROFILE);

  it.each(['/privacy', '/terms', '/support'])('links to %s', (href) => {
    // Apple requires the privacy policy to be reachable from inside the app,
    // not only from the store listing.
    expect(profile).toContain(`href: '${href}'`);
  });

  it('keeps the account-deletion control on the same screen', () => {
    expect(profile).toContain('DeleteAccount');
  });
});

describe('the privacy policy tells the truth about deletion', () => {
  const privacy = read(PRIVACY);

  it('names the in-app route rather than a support address', () => {
    expect(privacy).toContain('Profile → Account → Delete account');
  });

  it('says what is removed', () => {
    for (const claim of ['sign-in identity', 'profile photos', 'notification inbox']) {
      expect(privacy, `the policy does not mention ${claim}`).toContain(claim);
    }
  });

  it('does not claim that nothing is retained', () => {
    // The tombstone model keeps de-identified history on purpose. A policy
    // promising total erasure would be false, and this is the assertion that
    // fails if somebody "tidies up" the retention paragraph.
    expect(privacy).toContain('Former member');
    expect(privacy).toContain('no longer identify you');
  });

  it('does not promise absolute security', () => {
    // A substring that survives however the sentence happens to wrap in JSX.
    // The rendered form is asserted end-to-end; this guards the claim itself.
    expect(privacy).toContain('promise perfect security');
    for (const overclaim of [
      'completely secure',
      'absolutely secure',
      'guarantee the security',
      'cannot be breached',
    ]) {
      expect(privacy.toLowerCase(), `the policy claims ${overclaim}`).not.toContain(overclaim);
    }
  });

  it('names each real service provider', () => {
    for (const provider of ['Supabase', 'Vercel', 'Brevo', 'Better Stack']) {
      expect(privacy, `the policy omits ${provider}`).toContain(provider);
    }
  });

  it('claims no analytics or advertising, which the dependency list backs up', () => {
    expect(privacy).toContain('does not track you');

    // The claim is only safe while it stays true. Runtime dependencies are the
    // place an analytics or advertising SDK would appear.
    const runtime = Object.keys(
      (JSON.parse(read('package.json')) as { dependencies: Record<string, string> }).dependencies,
    );
    for (const name of runtime) {
      expect(
        /analytic|segment|amplitude|mixpanel|posthog|sentry|bugsnag|firebase|facebook|advert|gtag/i.test(
          name,
        ),
        `${name} is a runtime dependency, so the "no tracking" claim needs revisiting`,
      ).toBe(false);
    }
  });
});

describe('the support page', () => {
  const support = read(SUPPORT);

  it('reads the address from the existing project configuration', () => {
    // One source of truth with the in-app footer, rather than a second address
    // hard-coded into a page nobody remembers to update.
    expect(support).toContain('getSupportEmail');
    expect(support).not.toMatch(/href="mailto:[a-z]/i);
  });

  it('renders nothing rather than a dead link when none is configured', () => {
    expect(support).toContain('supportEmail === null');
  });

  it('sends people to the in-app deletion flow', () => {
    expect(support).toContain('Profile → Account → Delete account');
  });
});

describe('the terms suit a free pickup-soccer coordinator', () => {
  const terms = read(TERMS);

  it('does not claim MatchDay runs or supervises matches', () => {
    expect(terms).toContain('does not organise, run, referee or supervise matches');
  });

  it('mentions the physical risk in plain language, without medical claims', () => {
    expect(terms).toContain('own risk');
    for (const medical of ['medical advice', 'diagnose', 'treatment', 'physician-approved']) {
      expect(terms.toLowerCase(), `the terms make a medical claim: ${medical}`).not.toContain(
        medical,
      );
    }
  });

  it('points at the same deletion route as everything else', () => {
    expect(terms).toContain('Profile → Account → Delete account');
  });
});

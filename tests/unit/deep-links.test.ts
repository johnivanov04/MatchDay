import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NATIVE_LINK_HOST,
  matchesNativeRoute,
  resolveNativeDeepLink,
} from '@/lib/platform/deep-links';

/**
 * The app's half of the Universal Links contract.
 *
 * `aasa.test.ts` proves the document MatchDay serves to Apple. This proves what
 * the running app does with a URL Apple hands back — the half that decides
 * whether a tapped link lands on the right screen or quietly does nothing.
 */

const ENTITLEMENTS = fileURLToPath(
  new URL('../../ios/App/App/App.entitlements', import.meta.url),
);

describe('the entitlement and the code agree on the host', () => {
  /**
   * These two facts are established in different languages, at different times,
   * by different tools: one is compiled into a signed binary by Xcode, the
   * other runs in a webview. Nothing connects them but this assertion.
   *
   * Getting it wrong is silent in both directions. A host in the entitlement
   * that the code does not recognise means iOS opens the app for links it then
   * ignores. A host in the code that the entitlement does not claim means code
   * that can never run, which is merely dead — until somebody trusts it.
   */
  const entitlements = readFileSync(ENTITLEMENTS, 'utf8');
  const claimed = [...entitlements.matchAll(/<string>applinks:([^<]+)<\/string>/g)].map(
    (match) => match[1],
  );

  it('claims exactly the host the app routes for', () => {
    expect(claimed).toEqual([NATIVE_LINK_HOST]);
  });
});

describe('resolveNativeDeepLink', () => {
  const url = (path: string) => `https://${NATIVE_LINK_HOST}${path}`;

  it.each([
    ['/dashboard'],
    ['/notifications'],
    ['/profile'],
    ['/reset-password'],
    ['/invite/8f3a-not-a-uuid-shaped-token'],
    ['/leagues/rmv-football-club'],
    ['/leagues/rmv-football-club/matches/aaaaaaaa-aaaa-4aaa-8aaa-000000000001'],
    ['/settings/devices'],
  ])('opens %s in the app', (path) => {
    expect(resolveNativeDeepLink(url(path))).toBe(path);
  });

  it('keeps the query string, which is the whole payload of a confirmation link', () => {
    // `/auth/continue` without its token is a page that can do nothing at all.
    expect(resolveNativeDeepLink(url('/auth/continue?token_hash=pkce_abc123&type=signup'))).toBe(
      '/auth/continue?token_hash=pkce_abc123&type=signup',
    );
  });

  describe('the exact URLs used at the physical checkpoint', () => {
    /**
     * Pinned verbatim, because these two were the ones that appeared to fail on
     * device. They did not: no client JavaScript had loaded, so this function
     * was never called at all. Keeping the literal strings means the next
     * person to see that symptom can rule this out in one test run.
     */
    it('resolves the invite link, token intact', () => {
      expect(
        resolveNativeDeepLink(
          'https://app.matchdayapps.com/invite/matchday-local-development-invite-token-0001',
        ),
      ).toBe('/invite/matchday-local-development-invite-token-0001');
    });

    it('resolves the confirmation link with both parameters intact', () => {
      expect(
        resolveNativeDeepLink(
          'https://app.matchdayapps.com/auth/continue' +
            '?token_hash=pkce_matchday_universal_link_probe_0001&type=signup',
        ),
      ).toBe('/auth/continue?token_hash=pkce_matchday_universal_link_probe_0001&type=signup');
    });
  });

  it('keeps a fragment', () => {
    expect(resolveNativeDeepLink(url('/dashboard#upcoming'))).toBe('/dashboard#upcoming');
  });

  it.each([
    ['/privacy', 'the reviewer opens this from the App Store listing'],
    ['/terms', 'likewise'],
    ['/support', 'likewise'],
    ['/sign-in', 'browser sessions stay in the browser'],
    ['/sign-up', 'likewise'],
    ['/api/cron/reminders', 'not a screen'],
    ['/.well-known/apple-app-site-association', 'the association document itself'],
  ])('leaves %s to the browser (%s)', (path) => {
    expect(resolveNativeDeepLink(url(path))).toBeNull();
    expect(matchesNativeRoute(path)).toBe(false);
  });

  it('ignores a path nobody claimed', () => {
    expect(resolveNativeDeepLink(url('/'))).toBeNull();
    expect(resolveNativeDeepLink(url('/offline.html'))).toBeNull();
  });

  describe('refuses anything that is not our https origin', () => {
    it.each([
      [`http://${NATIVE_LINK_HOST}/dashboard`, 'plain http'],
      [`javascript:alert(1)//${NATIVE_LINK_HOST}/dashboard`, 'a javascript URL'],
      [`file:///dashboard`, 'a file URL'],
      [`matchday://${NATIVE_LINK_HOST}/dashboard`, 'a custom scheme'],
      [`https://${NATIVE_LINK_HOST}.evil.test/dashboard`, 'a suffix-extended lookalike'],
      [`https://evil-app.matchdayapps.com/dashboard`, 'a sibling subdomain'],
      [`https://matchdayapps.com/dashboard`, 'the bare apex, which is not entitled'],
      ['https://match-day-lake.vercel.app/dashboard', 'the deployment alias'],
      ['https://evil.test/dashboard', 'somebody else entirely'],
      ['not a url at all', 'garbage'],
      ['', 'nothing'],
    ])('rejects %s (%s)', (candidate) => {
      expect(resolveNativeDeepLink(candidate)).toBeNull();
    });

    it('matches the host case-insensitively, as DNS does', () => {
      expect(resolveNativeDeepLink(`https://APP.MatchDayApps.com/dashboard`)).toBe('/dashboard');
    });
  });

  describe('never yields something that could navigate off-origin', () => {
    /**
     * Whatever comes back is handed straight to `router.push`. A value starting
     * with `//` is a protocol-relative URL and would leave the app entirely,
     * carrying a signed-in session with it.
     */
    it.each([
      `https://${NATIVE_LINK_HOST}//evil.test`,
      `https://${NATIVE_LINK_HOST}//leagues/x`,
      `https://${NATIVE_LINK_HOST}/leagues/..//evil.test`,
      `https://${NATIVE_LINK_HOST}/\\evil.test`,
      `https://${NATIVE_LINK_HOST}/dashboard/../../evil.test`,
    ])('%s resolves to null or a single-slash path', (candidate) => {
      const resolved = resolveNativeDeepLink(candidate);
      if (resolved !== null) {
        expect(resolved.startsWith('/')).toBe(true);
        expect(resolved.startsWith('//')).toBe(false);
      }
    });
  });
});

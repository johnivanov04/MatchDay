import { describe, expect, it } from 'vitest';
import {
  APPLE_APP_SITE_ASSOCIATION,
  MATCHDAY_APP_ID,
  GET,
  matchesNativeRoute,
} from '@/app/.well-known/apple-app-site-association/route';
import { config as proxyConfig } from '@/proxy';

/**
 * The server's half of the Universal Links contract.
 *
 * ── WHAT THIS FILE CAN AND CANNOT PROVE ────────────────────────────────────
 *
 * It proves the document MatchDay serves: the content type, the app id, the
 * ordering of the components and which paths each one claims. That is the only
 * half testable before deployment.
 *
 * It proves nothing about Universal Links actually working. Apple's association
 * system fetches this from the public internet through its own CDN and caches
 * the result; until the endpoint is live on app.matchdayapps.com, no link has
 * been verified by anything. Nothing here simulates that, deliberately — a test
 * that pretended to would be worse than no test.
 */

const details = APPLE_APP_SITE_ASSOCIATION.applinks.details[0]!;

describe('the response', () => {
  it('answers 200', () => {
    expect(GET().status).toBe(200);
  });

  it('declares application/json', async () => {
    // THE SINGLE MOST COMMON REASON AN ASSOCIATION SILENTLY FAILS. A file in
    // `public/` with no extension is served as octet-stream and iOS just
    // declines to associate, with no error anybody sees.
    const response = GET();
    expect(response.headers.get('content-type')).toBe('application/json');
  });

  it('is parseable JSON matching the document', async () => {
    const body = await GET().json();
    expect(body).toEqual(APPLE_APP_SITE_ASSOCIATION);
  });

  it('does not redirect', () => {
    const response = GET();
    expect(response.status).toBeLessThan(300);
    expect(response.headers.get('location')).toBeNull();
  });
});

describe('the app id', () => {
  it('is the signed TeamID.BundleID', () => {
    // From `DEVELOPMENT_TEAM` in the Xcode project, corroborated against the
    // real store provisioning profile's `application-identifier`.
    expect(MATCHDAY_APP_ID).toBe('VYC3499K46.com.johnivanov.matchday');
    expect(details.appIDs).toEqual(['VYC3499K46.com.johnivanov.matchday']);
  });

  it('uses the modern schema, with no legacy `apps` or `paths` key', () => {
    expect(details).toHaveProperty('components');
    expect(APPLE_APP_SITE_ASSOCIATION.applinks).not.toHaveProperty('apps');
    expect(details).not.toHaveProperty('paths');
  });
});

describe('component ordering', () => {
  it('places every exclusion before every positive match', () => {
    // iOS stops at the first matching component. An exclusion listed after
    // `/leagues/*` would never be reached for `/leagues/anything`, so the
    // ordering is load-bearing rather than stylistic.
    const kinds = details.components.map((component) => component.exclude === true);
    const firstPositive = kinds.indexOf(false);
    const lastExclusion = kinds.lastIndexOf(true);

    expect(firstPositive).toBeGreaterThan(-1);
    expect(lastExclusion).toBeGreaterThan(-1);
    expect(lastExclusion).toBeLessThan(firstPositive);
  });

  it('gives every component a comment, which Apple requires', () => {
    for (const component of details.components) {
      expect(component.comment, `${component['/']} has no comment`).toBeTruthy();
    }
  });
});

describe('paths the app claims', () => {
  it.each([
    '/auth/continue',
    '/reset-password',
    '/dashboard',
    '/notifications',
    '/profile',
  ])('claims %s', (path) => {
    expect(matchesNativeRoute(path)).toBe(true);
  });

  it.each([
    '/invite/matchday-invite-token-0001',
    '/leagues/weeknight-5v5',
    '/leagues/weeknight-5v5/matches',
    '/leagues/weeknight-5v5/matches/aaaaaaaa-aaaa-4aaa-8aaa-000000000011',
    '/leagues/weeknight-5v5/matches/aaaaaaaa-aaaa-4aaa-8aaa-000000000011/teams',
    '/settings/devices',
  ])('claims the nested path %s', (path) => {
    // `*` spans `/`, so one pattern covers a whole subtree.
    expect(matchesNativeRoute(path)).toBe(true);
  });
});

describe('query strings', () => {
  it.each([
    '/auth/continue?token_hash=pkce_abc123&type=signup',
    '/auth/continue?token_hash=pkce_abc123&type=recovery&next=%2Fdashboard',
    '/auth/continue?type=magiclink',
  ])('keeps %s eligible', (url) => {
    // The confirmation token lives in the query. Components match on path
    // unless a `"?"` key says otherwise, and none here does — so iOS hands the
    // app the URL complete, which is the only reason the flow works at all.
    expect(matchesNativeRoute(url)).toBe(true);
  });

  it('matches the dashboard regardless of its notice parameter', () => {
    expect(matchesNativeRoute('/dashboard?notice=left-league')).toBe(true);
  });
});

describe('paths that must stay in the browser', () => {
  it.each(['/privacy', '/terms', '/support'])('excludes %s', (path) => {
    // App Review opens the Privacy Policy and Support URLs from the store
    // listing. An app that hijacks them makes the submission look broken.
    expect(matchesNativeRoute(path)).toBe(false);
  });

  it.each([
    '/api/health',
    '/api/cron/reminders',
    '/.well-known/apple-app-site-association',
    '/sign-in',
    '/sign-up',
  ])('excludes %s', (path) => {
    expect(matchesNativeRoute(path)).toBe(false);
  });

  it('claims nothing that was not reviewed', () => {
    for (const path of ['/', '/onboarding', '/leagues', '/account/deleted', '/forgot-password']) {
      expect(matchesNativeRoute(path), `${path} is claimed but was not reviewed`).toBe(false);
    }
  });
});

describe('the proxy matcher', () => {
  const matcher = proxyConfig.matcher[0]!;
  const pattern = new RegExp(`^${matcher}$`);

  it('no longer runs for the association document', () => {
    // Apple's fetch carries no cookies and has nothing to refresh, so a
    // Supabase session lookup in front of it is pure latency.
    expect(pattern.test('/.well-known/apple-app-site-association')).toBe(false);
    expect(pattern.test('/.well-known/anything-else')).toBe(false);
  });

  it('still runs for every ordinary route', () => {
    // The regression guard: this matcher governs session refresh for the whole
    // product, and narrowing it by accident would sign people out.
    for (const path of [
      '/',
      '/dashboard',
      '/sign-in',
      '/profile',
      '/notifications',
      '/leagues/weeknight-5v5/matches',
      '/privacy',
      '/api/health',
      '/auth/continue',
    ]) {
      expect(pattern.test(path), `${path} no longer refreshes the session`).toBe(true);
    }
  });

  it('still skips the static assets it always skipped', () => {
    for (const path of ['/_next/static/chunk.js', '/_next/image', '/favicon.ico', '/icon.svg']) {
      expect(pattern.test(path), `${path} unexpectedly entered the proxy`).toBe(false);
    }
  });
});

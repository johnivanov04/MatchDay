import { NextResponse } from 'next/server';

/**
 * The Apple App Site Association document.
 *
 * ── WHY A ROUTE HANDLER AND NOT A FILE IN `public/` ────────────────────────
 *
 * Apple requires this document at `/.well-known/apple-app-site-association`
 * with **no file extension** and `Content-Type: application/json`. A file in
 * `public/` with no extension gets whatever content type the platform guesses —
 * usually `application/octet-stream` — and the association silently fails with
 * no error anybody can see. A route handler states the content type outright.
 *
 * Apple's CDN also refuses to follow redirects when fetching this. Nothing here
 * redirects, and `src/proxy.ts` excludes `.well-known` so the request does not
 * even reach the session-refresh path.
 *
 * ── WHAT THIS DOES NOT PROVE ───────────────────────────────────────────────
 *
 * Serving valid JSON is the server's half of the contract and the only half
 * that can be tested before deployment. Apple's association system fetches this
 * from the public internet through its own CDN, so Universal Links are not
 * working until this is live on `app.matchdayapps.com` and verified there. See
 * `docs/operations/production.md` §11.
 */

/**
 * `TeamID.BundleID`, read from the signed project rather than typed from
 * memory: `DEVELOPMENT_TEAM` in `ios/App/App.xcodeproj/project.pbxproj`, and
 * corroborated against the `application-identifier` entitlement in the real
 * "iOS Team Store Provisioning Profile: com.johnivanov.matchday".
 *
 * A wrong value here fails silently — iOS simply declines to associate — and
 * Apple's CDN caches the mistake, so it is worth being certain.
 */
export const MATCHDAY_APP_ID = 'VYC3499K46.com.johnivanov.matchday';

/**
 * Paths that must keep opening in a browser, whatever is installed.
 *
 * ── ORDER IS SIGNIFICANT ───────────────────────────────────────────────────
 *
 * iOS evaluates `components` top to bottom and stops at the first match. An
 * exclusion listed *after* a pattern that also matches is dead: `/leagues/*`
 * would claim `/leagues/foo` before a later exclusion ever ran. So every
 * exclusion is declared first, and the tests assert that ordering rather than
 * trusting it to survive an edit.
 *
 * The three legal pages are the ones that matter most. Apple's own reviewer
 * opens the Privacy Policy and Support URLs from the App Store listing, in a
 * browser, and an app that hijacks them makes a submission look broken.
 */
const EXCLUDED_PATHS = [
  '/privacy',
  '/terms',
  '/support',
  '/api/*',
  '/.well-known/*',
  '/sign-in',
  '/sign-up',
] as const;

/**
 * The destinations the app is allowed to open natively.
 *
 * Deliberately a short, reviewed list rather than a catch-all: everything here
 * is a screen somebody arrives at from an email or a notification and expects
 * to land inside MatchDay.
 *
 * `*` matches any run of characters including `/`, so `/leagues/*` covers
 * `/leagues/<slug>/matches/<id>` and `/invite/*` covers a token of any shape.
 *
 * QUERY STRINGS ARE UNAFFECTED. A component with only a `"/"` key matches on
 * path alone, so `/auth/continue?token_hash=…&type=signup` is eligible and iOS
 * hands the app the URL complete with its query — which is the whole point for
 * a confirmation link, since the token lives there.
 */
const INCLUDED_PATHS = [
  '/auth/continue',
  '/reset-password',
  '/invite/*',
  '/dashboard',
  '/notifications',
  '/profile',
  '/leagues/*',
  '/settings/*',
] as const;

export interface AasaComponent {
  '/': string;
  exclude?: true;
  comment: string;
}

export interface AppleAppSiteAssociation {
  applinks: {
    details: Array<{
      appIDs: string[];
      components: AasaComponent[];
    }>;
  };
}

/**
 * The document itself.
 *
 * Modern `appIDs` + `components`, not the legacy `apps` + `paths` pair. `apps`
 * is deliberately absent: it has been unnecessary for years and its presence
 * invites confusion about which schema is in force.
 */
export const APPLE_APP_SITE_ASSOCIATION: AppleAppSiteAssociation = {
  applinks: {
    details: [
      {
        appIDs: [MATCHDAY_APP_ID],
        components: [
          ...EXCLUDED_PATHS.map(
            (path): AasaComponent => ({
              '/': path,
              exclude: true,
              comment: 'Always opens in the browser.',
            }),
          ),
          ...INCLUDED_PATHS.map(
            (path): AasaComponent => ({
              '/': path,
              comment: 'Opens in MatchDay when the app is installed.',
            }),
          ),
        ],
      },
    ],
  },
};

/**
 * Whether iOS would hand a given path to the app.
 *
 * Exported for the tests, and written to mirror the matching rules rather than
 * to describe them: first match wins, and `*` spans `/`. Keeping one
 * implementation means a test cannot pass against a second, kinder reading of
 * the same list.
 *
 * The query string is stripped before matching, because that is what iOS does —
 * components match on path unless a `"?"` key says otherwise, and none here
 * does.
 */
export function matchesNativeRoute(pathWithQuery: string): boolean {
  const path = pathWithQuery.split(/[?#]/, 1)[0] ?? '';

  for (const component of APPLE_APP_SITE_ASSOCIATION.applinks.details[0]?.components ?? []) {
    if (!globToRegExp(component['/']).test(path)) {
      continue;
    }
    // First match wins, in file order — an exclusion reached first is final.
    return component.exclude !== true;
  }

  return false;
}

/** `*` → any characters (including `/`), `?` → exactly one. Everything else literal. */
function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('')
    .map((character) => {
      if (character === '*') return '.*';
      if (character === '?') return '.';
      return character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');

  return new RegExp(`^${source}$`);
}

/**
 * Prerendered. The document is a constant, so there is nothing to compute per
 * request and no reason to keep a serverless function warm for Apple's CDN.
 */
export const dynamic = 'force-static';

export function GET(): NextResponse {
  return NextResponse.json(APPLE_APP_SITE_ASSOCIATION, {
    status: 200,
    headers: {
      // Stated explicitly rather than relying on the framework default: this
      // header is the single most common reason an association silently fails.
      'Content-Type': 'application/json',
      // Apple re-fetches periodically. A day is long enough to be cheap and
      // short enough that a correction is not stuck behind a week of caching.
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

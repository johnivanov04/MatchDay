/**
 * Which MatchDay URLs belong to the app, and what the app does with one.
 *
 * ── ONE LIST, TWO CONSUMERS ────────────────────────────────────────────────
 *
 * The same path set has to be stated in two places that must never disagree:
 *
 *   * the Apple App Site Association document, which tells iOS which links to
 *     hand to the app — served by
 *     `src/app/.well-known/apple-app-site-association/route.ts`;
 *   * the running app, which has to turn a URL iOS just handed it into a
 *     screen — `src/components/native-shell.tsx`.
 *
 * They live here together. A drift between them is not a loud failure: iOS
 * would open the app for a link the app then silently ignores, leaving somebody
 * staring at their dashboard wondering where the match went.
 *
 * This module is deliberately free of `next/server` and of anything else that
 * cannot run in a browser, because half of its callers are client components.
 * That is why it is not simply exported from the route handler.
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
 * The one host the app is entitled to open links for.
 *
 * This must equal the domain in `applinks:` in `ios/App/App/App.entitlements`.
 * Nothing at runtime can check that — the entitlement is a build-time fact —
 * so `tests/unit/deep-links.test.ts` reads the entitlements file and asserts
 * the two agree.
 */
export const NATIVE_LINK_HOST = 'app.matchdayapps.com';

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
 * Written to mirror the matching rules rather than to describe them: first
 * match wins, and `*` spans `/`. Keeping one implementation means a test cannot
 * pass against a second, kinder reading of the same list.
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
 * Turn a URL iOS handed the app into a route to navigate to, or `null`.
 *
 * ── THIS RE-CHECKS WHAT iOS ALREADY CHECKED ────────────────────────────────
 *
 * iOS only delivers links matching the entitlement and the association
 * document, so in principle every URL arriving here is already ours and
 * already claimed. The checks are repeated anyway because this same entry point
 * also receives custom-scheme opens, which are subject to no such filtering,
 * and because the cost of being wrong is navigating a signed-in session
 * somewhere an attacker chose.
 *
 * A URL that fails any check is dropped rather than opened elsewhere. iOS is
 * the one that decides a link is not ours — if it were not ours it would have
 * gone to Safari and never reached this function — so there is nothing sensible
 * left to do with one that arrives here anyway.
 */
export function resolveNativeDeepLink(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  // `https` only. A universal link is always https, and refusing everything
  // else means a custom-scheme open cannot smuggle in a `javascript:` or
  // `file:` target.
  if (url.protocol !== 'https:') {
    return null;
  }

  // Exact host. Not `endsWith`, which would accept `app.matchdayapps.com.evil`,
  // and not the deployment's Vercel alias, which the entitlement does not
  // claim.
  if (url.hostname.toLowerCase() !== NATIVE_LINK_HOST) {
    return null;
  }

  if (!matchesNativeRoute(url.pathname)) {
    return null;
  }

  // The query survives. `/auth/continue?token_hash=…` is worthless without it.
  return `${url.pathname}${url.search}${url.hash}`;
}

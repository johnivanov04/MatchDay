import { NextResponse } from 'next/server';
import { APPLE_APP_SITE_ASSOCIATION } from '@/lib/platform/deep-links';

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
 * ── WHERE THE CONTENT LIVES ────────────────────────────────────────────────
 *
 * In `src/lib/platform/deep-links.ts`, alongside the matcher the running app
 * uses to turn one of these links into a screen. The two must never disagree,
 * and a client component cannot import this file — it would pull `next/server`
 * into the browser bundle. See that module's header.
 *
 * ── WHAT THIS DOES NOT PROVE ───────────────────────────────────────────────
 *
 * Serving valid JSON is the server's half of the contract and the only half
 * that can be tested before deployment. Apple's association system fetches this
 * from the public internet through its own CDN, so Universal Links are not
 * working until this is live on `app.matchdayapps.com` and verified there. See
 * `docs/operations/production.md` §11.
 */

// Re-exported so the document, its app id and the matcher can all still be
// reached from where they were before the move.
export {
  APPLE_APP_SITE_ASSOCIATION,
  MATCHDAY_APP_ID,
  matchesNativeRoute,
  type AasaComponent,
  type AppleAppSiteAssociation,
} from '@/lib/platform/deep-links';

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

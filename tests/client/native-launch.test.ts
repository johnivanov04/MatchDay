import { beforeEach, describe, expect, it } from 'vitest';
import { clearConsumedLaunchUrl, planNativeNavigation } from '@/lib/platform/native-launch';

/**
 * The launch-URL replay rule.
 *
 * ── HOW A DOCUMENT RELOAD IS MODELLED ──────────────────────────────────────
 *
 * `planNativeNavigation` holds no module state at all: the marker lives
 * entirely in `sessionStorage`. That is the point — a reload destroys module
 * state and leaves `sessionStorage` standing, so calling the function again
 * with nothing cleared *is* a faithful model of the reloaded document, and no
 * module re-import is needed to simulate one.
 *
 * The bug these prove absent was measured on device: one tap on a claimed URL
 * with no matching route produced 630 requests in 54 seconds, because each 404
 * forced a reload, the reload reset the module guards, and `getLaunchUrl()`
 * — which Capacitor never clears — answered the same as before.
 */

const MATCH = 'https://app.matchdayapps.com/leagues/rmv-football-club/matches/aaaa-0001';
const NO_SUCH_ROUTE = 'https://app.matchdayapps.com/leagues/rmv-football-club';
const NOTIFICATIONS = 'https://app.matchdayapps.com/notifications';

beforeEach(() => {
  window.sessionStorage.clear();
  clearConsumedLaunchUrl();
});

describe('a cold launch URL', () => {
  it('is handled once', () => {
    expect(planNativeNavigation(MATCH, 'launch')).toBe(
      '/leagues/rmv-football-club/matches/aaaa-0001',
    );
  });

  it('is not handled again after a full document reload', () => {
    // The whole defect, stated in two lines. The second call is the reloaded
    // document asking `getLaunchUrl()` the same question and being told the
    // answer has already been acted on.
    expect(planNativeNavigation(MATCH, 'launch')).not.toBeNull();
    expect(planNativeNavigation(MATCH, 'launch')).toBeNull();
  });

  it('does not suppress a different launch URL later in the session', () => {
    expect(planNativeNavigation(MATCH, 'launch')).not.toBeNull();
    expect(planNativeNavigation(NOTIFICATIONS, 'launch')).toBe('/notifications');
  });
});

describe('a claimed URL with no matching route cannot loop', () => {
  /**
   * `/leagues/*` is claimed by the association document, but `/leagues/[slug]`
   * is not a route — there is no bare page, only children. iOS therefore hands
   * the app a URL that renders its own "Page not found", and the App Router
   * reaches that by way of a full page load.
   */
  it('navigates once and never again, however many reloads follow', () => {
    const results = [planNativeNavigation(NO_SUCH_ROUTE, 'url-open')];
    // Twenty reloads. Before the fix this was ~16 navigations per second for as
    // long as the app stayed open.
    for (let reload = 0; reload < 20; reload += 1) {
      results.push(planNativeNavigation(NO_SUCH_ROUTE, 'launch'));
    }

    expect(results[0]).toBe('/leagues/rmv-football-club');
    expect(results.slice(1).every((r) => r === null)).toBe(true);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });
});

describe('a warm appUrlOpen', () => {
  it('is handled', () => {
    expect(planNativeNavigation(MATCH, 'url-open')).toBe(
      '/leagues/rmv-football-club/matches/aaaa-0001',
    );
  });

  it('is handled again when the same link is tapped a second time', () => {
    /**
     * The asymmetry that makes the fix safe. A tap is a fresh intention, even
     * on a link the app is already showing — somebody who has wandered off and
     * taps the same message again expects to go back there. Deduplicating by
     * URL would swallow it, and a swallowed tap reads as a broken app.
     */
    expect(planNativeNavigation(MATCH, 'url-open')).not.toBeNull();
    expect(planNativeNavigation(MATCH, 'url-open')).not.toBeNull();
    expect(planNativeNavigation(MATCH, 'url-open')).not.toBeNull();
  });

  it('marks the URL consumed before navigating, so a reload it causes is suppressed', () => {
    // The exact device sequence: warm tap -> navigate -> 404 -> reload ->
    // getLaunchUrl replays the same URL.
    expect(planNativeNavigation(NO_SUCH_ROUTE, 'url-open')).not.toBeNull();
    expect(planNativeNavigation(NO_SUCH_ROUTE, 'launch')).toBeNull();
  });

  it('leaves a later launch URL of its own free', () => {
    expect(planNativeNavigation(MATCH, 'url-open')).not.toBeNull();
    expect(planNativeNavigation(NOTIFICATIONS, 'launch')).toBe('/notifications');
  });
});

describe('a URL that resolves to nothing', () => {
  it.each([
    ['https://app.matchdayapps.com/privacy', 'an excluded path'],
    ['https://evil.test/dashboard', 'somebody else’s host'],
    ['http://app.matchdayapps.com/dashboard', 'plain http'],
    ['not a url at all', 'garbage'],
    ['', 'nothing'],
  ])('never navigates: %s (%s)', (candidate) => {
    expect(planNativeNavigation(candidate, 'launch')).toBeNull();
    expect(planNativeNavigation(candidate, 'url-open')).toBeNull();
  });

  it('does not become the consumed marker and mask a real link', () => {
    // A rejected URL must leave the marker alone, or the next genuine launch
    // URL could be suppressed by it.
    planNativeNavigation('https://evil.test/dashboard', 'url-open');
    planNativeNavigation('https://app.matchdayapps.com/privacy', 'launch');

    expect(planNativeNavigation(MATCH, 'launch')).toBe(
      '/leagues/rmv-football-club/matches/aaaa-0001',
    );
  });
});

describe('the marker is scoped to the WebView session', () => {
  it('lives in sessionStorage, not localStorage', () => {
    /**
     * `localStorage` would make this durable application state: a URL consumed
     * today would suppress a genuine cold launch to the same link tomorrow,
     * because a relaunched app really does start with that URL waiting in
     * `getLaunchUrl()`. Killing the app must forget it.
     */
    planNativeNavigation(MATCH, 'launch');

    const sessionKeys = Object.keys(window.sessionStorage);
    expect(sessionKeys.some((k) => k.includes('consumed-launch-url'))).toBe(true);
    expect(Object.keys(window.localStorage)).toHaveLength(0);
  });

  it('handles the URL again once the session is gone', () => {
    // What a genuine relaunch looks like: a fresh WebView, empty sessionStorage.
    planNativeNavigation(MATCH, 'launch');
    window.sessionStorage.clear();

    expect(planNativeNavigation(MATCH, 'launch')).not.toBeNull();
  });
});

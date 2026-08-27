import { resolveNativeDeepLink } from '@/lib/platform/deep-links';

/**
 * Deciding what to do with a URL iOS just handed the app.
 *
 * ── TWO SOURCES, AND ONLY ONE OF THEM IS A USER ACTION ─────────────────────
 *
 * `appUrlOpen` fires because somebody tapped a link, just now. Every one of
 * those is a fresh intention and must be acted on — including a second tap on
 * the same link the app is already showing.
 *
 * `getLaunchUrl()` is not an event. It reads
 * `ApplicationDelegateProxy.shared.lastURL`, which Capacitor writes on every
 * incoming link and **never clears**. Asking it twice returns the same answer
 * forever, so it is only meaningful once per WebView session.
 *
 * ── THE LOOP THIS EXISTS TO PREVENT ────────────────────────────────────────
 *
 * Module-scope flags guard the launch URL within one document. They do not
 * survive a document reload — and the App Router performs exactly that when a
 * client-side navigation lands on a 404, falling back to a full page load.
 *
 * Measured on device before this fix, one tap on a claimed URL with no matching
 * route produced **630 requests in 54 seconds**: navigate → 404 → reload →
 * module state resets → `getLaunchUrl()` returns the same URL → navigate. The
 * app was wedged on its own "Page not found" screen until it was backgrounded.
 *
 * ── WHY sessionStorage AND NOT localStorage ────────────────────────────────
 *
 * The marker has to outlive a document reload and nothing more. `localStorage`
 * would make it durable application state: a URL consumed on Tuesday would
 * still suppress a genuine cold launch to the same link on Wednesday, because a
 * relaunched app really does start with that URL waiting in `getLaunchUrl()`.
 * `sessionStorage` is scoped to the WebView session — it survives the reload
 * and is gone when the app is killed, which is exactly the lifetime of "this
 * launch URL has already been dealt with".
 */

/** Namespaced tightly: this is one flag about one WebView session. */
const CONSUMED_LAUNCH_URL_KEY = 'matchday.native.consumed-launch-url';

/** Where a native URL came from. It decides both suppression and history mode. */
export type NativeUrlSource =
  /** `App.getLaunchUrl()` — replay-prone, suppressed once consumed. */
  | 'launch'
  /** `appUrlOpen` — a tap that just happened, never suppressed. */
  | 'url-open';

function readConsumedUrl(): string | null {
  try {
    return window.sessionStorage.getItem(CONSUMED_LAUNCH_URL_KEY);
  } catch {
    // Storage can be unavailable or full. Reporting "nothing consumed" means a
    // launch URL is acted on, which is the failure worth having: the worst case
    // is the old behaviour, whereas reporting the opposite would silently drop
    // every cold-start deep link.
    return null;
  }
}

function writeConsumedUrl(rawUrl: string): void {
  try {
    window.sessionStorage.setItem(CONSUMED_LAUNCH_URL_KEY, rawUrl);
  } catch {
    // See above. A missing marker costs replay protection, not navigation.
  }
}

/**
 * The in-app path to navigate to for `rawUrl`, or `null` to do nothing.
 *
 * Records the URL as consumed **before** returning, so that a caller which
 * navigates and thereby triggers a document reload finds the marker already in
 * place when the reloaded document asks `getLaunchUrl()` the same question.
 * Recording after navigating would be too late: the reload can begin before the
 * next statement runs.
 *
 * Nothing is recorded for a URL that resolves to nothing. A rejected URL must
 * not become the consumed marker, or it would mask a later legitimate one.
 */
export function planNativeNavigation(rawUrl: string, source: NativeUrlSource): string | null {
  const target = resolveNativeDeepLink(rawUrl);
  if (target === null) {
    return null;
  }

  // Deliberately asymmetric. A launch URL that has already been dealt with in
  // this WebView session is a replay; an `appUrlOpen` carrying the same URL is
  // a person tapping the link again, and is always honoured.
  if (source === 'launch' && readConsumedUrl() === rawUrl) {
    return null;
  }

  writeConsumedUrl(rawUrl);
  return target;
}

/** Test seam: forgets which URL this session has consumed. */
export function clearConsumedLaunchUrl(): void {
  try {
    window.sessionStorage.removeItem(CONSUMED_LAUNCH_URL_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

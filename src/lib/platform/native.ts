/**
 * The one place MatchDay decides whether it is running inside the iOS app.
 *
 * ── WHY A USER-AGENT TAG AND NOT `window.Capacitor` ────────────────────────
 *
 * `window.Capacitor` only exists after the page has loaded and the bridge has
 * injected itself. MatchDay is 33 server-rendered routes, so by the time a
 * client component could ask, the server has already chosen the copy and sent
 * it — and branching afterwards means rendering "add MatchDay to your home
 * screen" and then snatching it away on hydration.
 *
 * `appendUserAgent` in `capacitor.config.ts` puts the tag on the very first
 * request instead, where the Proxy and every Server Component can see it. So
 * the decision is made once, on the server, before any HTML exists.
 *
 * ── THIS MODULE IS PURE ON PURPOSE ─────────────────────────────────────────
 *
 * No `next/headers`, no `server-only`, no Capacitor import — so a client
 * component can import the predicate without dragging a server module or a
 * native plugin into the browser bundle. The server-side reader lives in
 * `native-server.ts`, which is the only file that touches request headers.
 */

/**
 * Appended to the WKWebView's User-Agent by `capacitor.config.ts`.
 *
 * Deliberately not a word any real browser would contain. Both files must
 * change together, which is what `tests/unit/native-platform.test.ts` asserts.
 */
export const NATIVE_IOS_USER_AGENT_TAG = 'MatchDayiOS';

/**
 * Whether this User-Agent belongs to the MatchDay iOS app.
 *
 * A plain substring test, and that is enough: the tag is our own string,
 * appended by our own build, and nothing is authorized from the answer. It
 * chooses which sentence to show. A visitor who forges it sees native copy on
 * a desktop browser and nothing else happens.
 */
export function isNativeIOSUserAgent(userAgent: string | null | undefined): boolean {
  return typeof userAgent === 'string' && userAgent.includes(NATIVE_IOS_USER_AGENT_TAG);
}

/**
 * The same question in the browser, for the few places that genuinely cannot be
 * told by the server.
 *
 * Prefer passing the server's answer down as a prop. This exists for client
 * components that mount outside any page's data flow — and it agrees with the
 * server, because it reads the same tag from the same User-Agent.
 */
export function isNativeIOSClient(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return isNativeIOSUserAgent(navigator.userAgent);
}

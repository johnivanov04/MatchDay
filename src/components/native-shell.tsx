'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { isNativeIOSClient } from '@/lib/platform/native';

/**
 * The native behaviours that have to run in the browser, mounted once.
 *
 * ── FOUR JOBS, ALL NO-OPS ON THE WEB ───────────────────────────────────────
 *
 *   * uncover the app once MatchDay has actually painted;
 *   * make the status bar legible against MatchDay's own background;
 *   * send external links to the system browser instead of letting them
 *     replace the signed-in webview;
 *   * revalidate when the app comes back from the background.
 *
 * ── EVERY CAPACITOR IMPORT IS DYNAMIC ──────────────────────────────────────
 *
 * `await import('@capacitor/…')` inside the native branch, never a top-level
 * import. A static import would put four plugins into the browser bundle for
 * every web visitor, to run code that immediately decides it is not native.
 * The bundler cannot tree-shake them, because it cannot know the branch.
 */
export function NativeShell() {
  const router = useRouter();

  useEffect(() => {
    if (!isNativeIOSClient()) {
      return;
    }

    let disposed = false;
    const cleanups: Array<() => void> = [];

    void (async () => {
      // ── The splash ────────────────────────────────────────────────────────
      //
      // The fast path: hide as soon as MatchDay has mounted, which is the
      // earliest moment there is something worth showing. The native side also
      // carries a ten-second ceiling — see `capacitor.config.ts` — because this
      // code lives in the *deployed* web bundle, and a build that has not
      // landed yet cannot hide a splash it does not know about.
      try {
        const { SplashScreen } = await import('@capacitor/splash-screen');
        await SplashScreen.hide();
      } catch {
        // A splash that will not hide is far worse than one that never showed,
        // so this can never be allowed to throw.
      }

      if (disposed) return;

      // ── The status bar ────────────────────────────────────────────────────
      //
      // The webview draws behind it (`contentInset: 'never'`), so iOS is not
      // choosing a contrasting style for us. `Style.Default` follows the
      // system appearance, which is what MatchDay's own palette already does.
      try {
        const { StatusBar, Style } = await import('@capacitor/status-bar');
        await StatusBar.setStyle({ style: Style.Default });
      } catch {
        // Not fatal: a mis-styled status bar is cosmetic.
      }

      if (disposed) return;

      // ── Coming back from the background ──────────────────────────────────
      //
      // An app resumed after an hour is showing a stale page: the session may
      // have been refreshed, a match may have been cancelled, the unread badge
      // is probably wrong. `router.refresh()` re-runs the server render for the
      // current route, which re-reads the session cookie and the data with it.
      try {
        const { App } = await import('@capacitor/app');
        const listener = await App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) {
            router.refresh();
          }
        });
        cleanups.push(() => void listener.remove());
      } catch {
        // Without this the app still works; it is just staler on resume.
      }
    })();

    // ── External links ──────────────────────────────────────────────────────
    //
    // Capacitor's `allowNavigation` already refuses to navigate the webview to
    // an off-origin URL, but "refuses" is not the same as "handles well". Two
    // places in MatchDay render an administrator-supplied external address — a
    // match's map link and a league's guideline document — and both must open
    // somewhere the player can come back from.
    //
    // A capture-phase listener on the document, so it sees the click before any
    // component's own handler and regardless of where the anchor is rendered.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) {
        return;
      }

      const anchor = (event.target as Element | null)?.closest?.('a');
      if (anchor === null || anchor === undefined) {
        return;
      }

      const href = anchor.getAttribute('href');
      if (href === null || href === '') {
        return;
      }

      // `mailto:` and `tel:` are handed straight to iOS, which opens Mail and
      // Phone. Letting the webview try to navigate to them does nothing at all.
      if (/^(mailto|tel|sms):/i.test(href)) {
        return;
      }

      // Relative links, fragments and same-origin absolute links stay in the
      // app. `new URL` against the current location resolves all three
      // uniformly, so there is no string-prefix guessing.
      let target: URL;
      try {
        target = new URL(href, window.location.href);
      } catch {
        return;
      }

      if (target.origin === window.location.origin) {
        return;
      }

      // Anything else is somebody else's website. Open it in the in-app
      // browser: it keeps MatchDay running underneath with its session intact,
      // and returns the player to exactly where they were with one tap —
      // rather than switching to Safari and leaving the app behind.
      event.preventDefault();
      void (async () => {
        try {
          const { Browser } = await import('@capacitor/browser');
          await Browser.open({ url: target.href, presentationStyle: 'popover' });
        } catch {
          // If the in-app browser is unavailable, do the next best thing rather
          // than swallowing the tap entirely.
          window.open(target.href, '_blank', 'noopener,noreferrer');
        }
      })();
    };

    document.addEventListener('click', onClick, true);
    cleanups.push(() => document.removeEventListener('click', onClick, true));

    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, [router]);

  return null;
}

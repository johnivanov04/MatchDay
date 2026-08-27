'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { isNativeIOSClient } from '@/lib/platform/native';
import { planNativeNavigation } from '@/lib/platform/native-launch';
import { getInstallationId, refreshNativePushRegistration } from '@/lib/platform/apns-client';
import { isSafePushUrl } from '@/lib/push/payload';
import { registerApnsDeviceAction } from '@/server/actions/push';

/**
 * The native behaviours that have to run in the browser, mounted once.
 *
 * ── FOUR JOBS, ALL NO-OPS ON THE WEB ───────────────────────────────────────
 *
 *   * uncover the app once MatchDay has actually painted;
 *   * open a tapped MatchDay link on the screen it points at;
 *   * open a tapped notification on the screen it points at, and keep this
 *     device's APNs token current;
 *   * tell sign-out which installation is signing out;
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
/**
 * Whether this *document* has already consulted its launch URL.
 *
 * Module scope, not a ref, because the question is about the document and not
 * about any particular React mount — React's development double-invoke alone
 * would otherwise ask twice.
 *
 * This is only half the guard. Module state dies with the document, and the App
 * Router performs a full page load whenever a client-side navigation lands on a
 * 404 — so on that path this flag resets and `getLaunchUrl()`, which Capacitor
 * never clears, answers the same as before. The reload-surviving half lives in
 * `native-launch.ts`; see the loop it exists to prevent.
 */
let launchUrlConsulted = false;

/**
 * Whether a live `appUrlOpen` event has already been handled in this document.
 *
 * Cold-start links reach JavaScript twice: Capacitor retains the native event
 * until a listener exists (`retainUntilConsumed: true`), *and* leaves the same
 * URL readable through `getLaunchUrl()`. Whichever arrives first wins; this
 * flag stops the launch path acting on a link the listener already opened.
 *
 * The reverse order — `getLaunchUrl()` resolving before the retained event is
 * delivered — is not deduplicated, and would navigate to the same route twice.
 * That is the deliberate side of the trade: suppressing an `appUrlOpen` would
 * silently swallow a player tapping the *same* link a second time. A duplicate
 * navigation to somewhere you already are is a wasted render; a swallowed tap
 * looks like a broken app.
 */
let handledUrlOpenEvent = false;

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

    // ── Universal Links ─────────────────────────────────────────────────────
    //
    // A MatchDay link tapped in Mail, Messages or Notes opens the app rather
    // than Safari, and has to land on the screen it named. iOS only offers
    // links the entitlement and the association document both claim — see
    // `src/lib/platform/deep-links.ts` — so by the time one arrives here the
    // question is no longer "is this ours" but "which route is it".
    //
    // Its own `try`, and its own import of `@capacitor/app`, so that a failure
    // in the resume listener above cannot take deep linking down with it.
    void (async () => {
      const open = (rawUrl: string, source: 'launch' | 'url-open') => {
        if (disposed) {
          return;
        }

        // Resolves the URL, applies the replay rule for its source, and records
        // the consumption before returning — see `native-launch.ts`. Recording
        // has to happen before the navigation below, because that navigation is
        // what can trigger the document reload the marker exists to survive.
        const target = planNativeNavigation(rawUrl, source);
        if (target === null) {
          return;
        }

        // `replace` for the launch URL: the app has just finished loading its
        // start page, and that page is not somewhere the player asked to be, so
        // it should not be sitting behind them in the history. `push` for a link
        // tapped while the app was already running, which *is* a step forward
        // from wherever they were.
        if (source === 'launch') {
          router.replace(target);
        } else {
          router.push(target);
        }
      };

      try {
        const { App } = await import('@capacitor/app');

        // Registered before the launch URL is read, so a retained cold-start
        // event has the earliest chance to be delivered first.
        const listener = await App.addListener('appUrlOpen', ({ url }) => {
          handledUrlOpenEvent = true;
          open(url, 'url-open');
        });
        cleanups.push(() => void listener.remove());

        if (launchUrlConsulted) {
          return;
        }

        const launch = await App.getLaunchUrl();

        // Claimed only once the answer is in hand and this mount is still
        // alive. Setting it earlier would let a mount that gets torn down
        // before the promise settles — React's development double-invoke does
        // exactly that — consume the launch URL without ever opening it.
        if (disposed) {
          return;
        }
        launchUrlConsulted = true;

        if (!handledUrlOpenEvent && launch !== undefined && launch.url !== undefined) {
          open(launch.url, 'launch');
        }
      } catch {
        // A deep link that does not open is a disappointment. An exception here
        // would unmount the shell and take the splash screen with it.
      }
    })();

    // ── Notifications ───────────────────────────────────────────────────────
    //
    // Two listeners and one housekeeping call. None of them can produce a
    // permission prompt: `addListener` never asks, and the refresh below checks
    // the existing permission rather than requesting one. Opting in happens on
    // the devices page, from a tap, and nowhere else.
    void (async () => {
      try {
        const { PushNotifications } = await import('@capacitor/push-notifications');

        // A tapped notification. Capacitor retains this event until a listener
        // exists, so a tap that launched the app cold is delivered here too
        // rather than being lost to the startup race.
        const tapped = await PushNotifications.addListener(
          'pushNotificationActionPerformed',
          ({ notification }) => {
            const url = notification.data?.['url'];

            // The same check the service worker applies to a Web Push payload.
            // The value arrives from outside the app, and `router.push` would
            // follow whatever it is handed.
            if (typeof url === 'string' && isSafePushUrl(url)) {
              router.push(url);
            }
          },
        );
        cleanups.push(() => void tapped.remove());

        // Arriving while the app is open. iOS shows no banner in that case, so
        // the useful response is to make the app itself current — the inbox and
        // its unread count are server-rendered.
        const received = await PushNotifications.addListener('pushNotificationReceived', () => {
          router.refresh();
        });
        cleanups.push(() => void received.remove());

        await refreshNativePushRegistration(async (input) => {
          const formData = new FormData();
          formData.set('device_token', input.deviceToken);
          formData.set('environment', input.environment);
          formData.set('installation_id', input.installationId);
          formData.set('device_label', input.deviceLabel);

          const result = await registerApnsDeviceAction(null, formData);
          return { ok: result.ok };
        });
      } catch {
        // Notifications not working is a degradation, never a crash: every one
        // of them is also sitting in the in-app inbox.
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

    // ── Signing out ─────────────────────────────────────────────────────────
    //
    // The sign-out route removes this device's APNs registration, and needs to
    // be told which device that is. The installation id lives in local storage,
    // which the server cannot read, so it is attached to the form on its way
    // out.
    //
    // A capture-phase listener on the document rather than a hidden field in
    // each form: there are two sign-out forms today, they are plain server-side
    // posts in server components, and neither should have to know that a native
    // app exists. Appending an input while the submit event is being dispatched
    // is in time — the browser serialises the form after the event completes,
    // which is what makes the event cancelable.
    const onSubmit = (event: Event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) {
        return;
      }

      // Resolved against the current location rather than string-matched, so a
      // relative action, an absolute one and a fully-qualified one all agree.
      let action: URL;
      try {
        action = new URL(form.getAttribute('action') ?? '', window.location.href);
      } catch {
        return;
      }

      if (action.origin !== window.location.origin || action.pathname !== '/auth/sign-out') {
        return;
      }

      if (form.querySelector('input[name="installation_id"]') !== null) {
        return;
      }

      const installationId = getInstallationId();
      if (installationId === null) {
        return;
      }

      const field = document.createElement('input');
      field.type = 'hidden';
      field.name = 'installation_id';
      field.value = installationId;
      form.appendChild(field);
    };

    document.addEventListener('submit', onSubmit, true);
    cleanups.push(() => document.removeEventListener('submit', onSubmit, true));

    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, [router]);

  return null;
}

import type { CapacitorConfig } from '@capacitor/cli';

/**
 * MatchDay's native iOS shell.
 *
 * ── THE WEBVIEW LOADS PRODUCTION, AND THAT IS THE DESIGN ───────────────────
 *
 * MatchDay is 33 server-rendered routes, 70 Server Actions and a Next.js Proxy
 * that refreshes the Supabase session cookie. `output: 'export'` forbids all
 * three, so bundling the application into the app would not be a packaging
 * exercise — it would mean deleting the architecture and moving sessions out of
 * server-set cookies and into client-side storage, which is strictly less
 * secure than what ships today.
 *
 * So the webview loads the real thing over HTTPS. What makes this a native app
 * rather than a wrapper is everything around that: APNs push and Universal
 * Links (Build #2), and in this build a native launch experience, a real
 * offline screen, correct safe-area handling, system handling of external
 * links, and an application that knows it is running natively and stops telling
 * people to add it to their home screen.
 *
 * ── `webDir` IS NOT THE APPLICATION ────────────────────────────────────────
 *
 * `ios/App/App/public` holds exactly two files: the offline screen and its
 * stylesheet. It exists because a remote-loading webview shows a blank white
 * page when the network is down, and a blank white page is both a terrible
 * first impression and a plausible App Review rejection. `errorPath` points at
 * it. Nothing else is bundled, and nothing there is part of the product.
 */
const config: CapacitorConfig = {
  appId: 'com.johnivanov.matchday',
  appName: 'MatchDay',
  webDir: 'native/web',

  server: {
    // The canonical production origin. Not an environment variable: a build
    // that could point somewhere else is a build that could ship pointing
    // somewhere else, and this value is baked into an artefact that goes to
    // Apple.
    url: 'https://app.matchdayapps.com',

    // HTTPS only. `cleartext` would let a redirect or a mistyped URL downgrade
    // the whole application to plain HTTP.
    cleartext: false,

    // ── THE NAVIGATION ALLOWLIST ──────────────────────────────────────────
    //
    // Deliberately narrow. This is the set of origins the *webview itself* may
    // navigate to; anything else is intercepted and handed to the system
    // browser by `useExternalLinks`, so an administrator-supplied map link or
    // guideline document cannot replace the MatchDay session with an arbitrary
    // page.
    //
    // The Vercel origin stays for the transition period, because the old domain
    // still redirects and a link somebody saved last week should not strand
    // them. Supabase is here because avatar images and the Auth API are served
    // from it.
    allowNavigation: [
      'app.matchdayapps.com',
      'match-day-lake.vercel.app',
      '*.supabase.co',
    ],

    /**
     * Where the webview goes when the remote origin cannot be reached.
     *
     * Relative to `webDir`, so this resolves to the bundled offline screen
     * rather than to anything on the network — which is the whole point, since
     * by definition the network is what failed.
     */
    errorPath: 'offline.html',
  },

  ios: {
    /**
     * ── THE CANONICAL NATIVE SIGNAL ───────────────────────────────────────
     *
     * Appended to the WKWebView's User-Agent, which makes it visible to the
     * Next.js Proxy on the very first request — before any JavaScript runs, and
     * therefore in Server Components. That is what lets the application branch
     * server-side instead of scattering `window.Capacitor` checks through the
     * client tree and flashing the wrong copy before hydration.
     *
     * `src/lib/platform/native.ts` is the only place this string is read.
     */
    appendUserAgent: 'MatchDayiOS',

    /**
     * The webview draws behind the status bar and home indicator, and the CSS
     * `env(safe-area-inset-*)` values become non-zero. `pb-safe` already
     * consumes the bottom inset; the top inset is applied to the sticky app bar
     * in `app-shell.tsx`. See `globals.css` — neither is applied twice.
     */
    contentInset: 'never',

    // A dragging webview that reveals a grey void above a sticky header reads
    // as a web page. The app scrolls its content, not its window.
    scrollEnabled: true,
    limitsNavigationsToAppBoundDomains: false,

    // Matches `background_color` in the PWA manifest, so the moment before the
    // first paint is MatchDay-coloured rather than white.
    backgroundColor: '#ffffff',
  },

  plugins: {
    SplashScreen: {
      /**
       * ── A CEILING, NOT A TIMER ────────────────────────────────────────────
       *
       * `NativeShell` calls `SplashScreen.hide()` the moment MatchDay has
       * mounted, so in the ordinary case the splash lasts exactly as long as
       * the app takes to paint and this duration is never reached.
       *
       * It was `launchAutoHide: false` — hold forever, uncover only when the
       * app says it is ready — on the reasoning that a timer would reveal a
       * blank webview on a slow connection. The first simulator run disproved
       * that: the webview loads the *deployed* production build, and the
       * deployed build did not yet contain `NativeShell`, so nothing ever
       * called `hide()` and the app sat on the splash indefinitely. A stuck
       * splash is not a slow app; it is a dead one.
       *
       * That failure is not exotic. Any of these reproduces it: a deploy that
       * has not landed yet, a rollback to an older build, a JavaScript error
       * before the effect runs, a hydration failure, a service worker serving
       * stale HTML. The native side must not depend on the remote application
       * behaving correctly in order to become usable at all.
       *
       * Ten seconds is well past a normal cold start, so it is invisible when
       * things work, and it bounds the damage when they do not — a webview
       * still loading is recoverable, and `errorPath` catches the case where it
       * never will.
       */
      launchAutoHide: true,
      launchShowDuration: 10_000,
      backgroundColor: '#ffffff',
      showSpinner: false,
    },
  },
};

export default config;

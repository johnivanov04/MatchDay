/**
 * jsdom setup for the component suite.
 *
 * Two things this file does NOT do, deliberately:
 *
 *   * it does not polyfill canvas rendering. jsdom's `<canvas>` has no 2D
 *     context and no `toBlob` unless the native `canvas` package is installed,
 *     which would add a compiler toolchain to `npm ci` in order to test
 *     assertions about JPEG bytes that nobody is making. The image pipeline's
 *     tests stub those two methods and assert the *arguments* it passes —
 *     the crop box, the output dimensions, the quality — which is the part
 *     this repository is responsible for. Real encoding is exercised by the
 *     end-to-end suite, in a real browser, against a real file.
 *
 *   * it does not install a testing library. React 19 ships `act`, and
 *     `react-dom/client` renders; queries here are `querySelector` against a
 *     real DOM. One fewer dependency, and nothing is abstracted away.
 */

// React refuses to run its `act` scheduling unless this global is set, and
// warns loudly on every update if it is missing.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// `getPublicEnv` reads these into module constants at import time. Set here so
// every component file sees a consistent, obviously-fake project.
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-for-tests';
process.env.NEXT_PUBLIC_SITE_URL = 'https://matchday.test';

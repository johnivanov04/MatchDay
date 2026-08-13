import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * These tests run the real Next.js application against the real local Supabase
 * stack: real Row Level Security, real server actions, real database functions.
 * Nothing is mocked, and no test-only route or backdoor exists in `src/` — the
 * authentication fixture mints a genuine Supabase session through the Auth API,
 * exactly as a magic link would, and installs the resulting cookie.
 *
 * `supabase start` and `npm run db:reset` are the caller's responsibility (see
 * `e2e/global-setup.ts`, which verifies both and fails loudly rather than
 * silently testing an empty database).
 */
const PORT = Number(process.env['E2E_PORT'] ?? 3100);
const BASE_URL = process.env['E2E_BASE_URL'] ?? `http://127.0.0.1:${String(PORT)}`;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',

  // Every spec builds its own league, members and matches, so files are safe to
  // run together. Tests *within* a file that share one journey are marked
  // `describe.serial` in the file itself.
  fullyParallel: true,

  // ── ONE WORKER, BY DEFAULT AND ON PURPOSE ────────────────────────────────
  //
  // Not because the specs interfere — they do not. Every spec builds its own
  // league, members and matches, and `fullyParallel` above stays true, so the
  // suite is correct at any worker count. This is about the *stack* underneath
  // it.
  //
  // The local Supabase container runs GoTrue without connection pooling, and
  // the application validates the session against it on every render. So each
  // concurrent worker multiplies both the token minting and the per-render
  // validation, GoTrue opens a PostgreSQL connection per request, and the
  // Docker bridge's ephemeral ports run out. The symptoms are not obviously
  // related to each other, which is what made this worth pinning down:
  //
  //   * `admin/generate_link` answering 500, so a sign-in fails outright;
  //   * a render taking longer than an assertion's 10s budget, so a perfectly
  //     correct page "does not contain" text that arrives at 11s;
  //   * a whole test exceeding its timeout waiting for that page.
  //
  // All three are the same pressure. Verified by elimination rather than
  // assumed: across a failing run the Next.js server logged **no** 5xx of its
  // own, and `withTransientRetry` in `e2e/support/auth.ts` wraps only the two
  // GoTrue admin endpoints — it cannot see, let alone retry, an application
  // response. An application 500 still fails a test immediately.
  //
  // Three workers cost ~20 failures a run; two cost ~4; one costs none. The
  // fix is therefore the honest one — stop generating the pressure — rather
  // than a wider retry budget, which would only buy silence and would blunt
  // the suite's ability to catch a genuine slow path.
  //
  // Roughly four minutes instead of two and a half. Reproducibility is worth
  // ninety seconds. For a tight edit-run loop on one file, pass `--workers=N`
  // explicitly or use `npm run test:e2e:parallel`; the canonical commands —
  // `npm run test:e2e`, `npm run test:e2e:fresh` and CI — all take this.
  workers: 1,

  // A failing assertion here is a real regression, not flake. One retry in CI
  // absorbs container jitter without hiding a genuine failure, and none locally
  // so a flaky test is visible immediately.
  retries: process.env['CI'] === undefined ? 0 : 1,
  forbidOnly: process.env['CI'] !== undefined,

  // Back to 45s. It was briefly 75s to accommodate a large sign-in retry
  // budget; both that budget and the pressure that needed it are gone, and the
  // slowest spec in the suite finishes well inside 10s. A generous timeout on
  // a healthy stack only delays the report of a real hang.
  timeout: 45_000,
  expect: { timeout: 10_000 },

  reporter: process.env['CI'] === undefined ? [['list']] : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // Deterministic rendering: the app formats league times in each league's own
    // IANA zone, so the browser's zone must never be able to influence an
    // assertion about a match time.
    timezoneId: 'UTC',
    locale: 'en-GB',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    // A production build, so the suite exercises what actually ships rather
    // than the dev server's error overlay and looser behaviour.
    //
    // `reuseExistingServer` locally is what keeps the inner loop usable: the
    // build dominates the run time, so a developer starts the server once
    // (`npm run build && npx next start --port 3100`) and every subsequent
    // invocation attaches to it in milliseconds. CI always builds fresh.
    command: `npm run build && npx next start --port ${String(PORT)}`,
    url: BASE_URL,
    reuseExistingServer: process.env['CI'] === undefined,
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});

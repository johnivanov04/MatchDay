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
  // Modest on purpose. The local Supabase stack runs GoTrue without connection
  // pooling, and the application validates the session against it on every
  // render, so GoTrue opens a PostgreSQL connection per request and eventually
  // exhausts the Docker bridge's ephemeral ports. That is stack capacity, not
  // an application fault — see `npm run test:e2e:fresh`, which starts from a
  // clean stack, and the note in NEXT_STEPS.md.
  workers: process.env['CI'] === undefined ? 3 : 2,

  // A failing assertion here is a real regression, not flake. One retry in CI
  // absorbs container jitter without hiding a genuine failure, and none locally
  // so a flaky test is visible immediately.
  retries: process.env['CI'] === undefined ? 0 : 1,
  forbidOnly: process.env['CI'] !== undefined,

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

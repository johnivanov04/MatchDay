import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcAlias = fileURLToPath(new URL('./src', import.meta.url));

// `server-only` throws unless resolved under the `react-server` export
// condition. Point it at an empty module, exactly as that condition does, so
// server modules can be imported by a test. See tests/stubs/server-only.ts.
const serverOnlyStub = fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url));

const alias = { '@': srcAlias, 'server-only': serverOnlyStub };

/**
 * Four projects, and the fourth is not in `npm test` on purpose.
 *
 * `unit`, `db` and `client` need nothing but this repository: they boot their
 * own PostgreSQL, or their own DOM, and run anywhere.
 *
 * `storage` does not. It speaks HTTP to a real Supabase Storage service,
 * because `allowed_mime_types` and `file_size_limit` are enforced by that
 * service and by nothing else — no constraint, no policy, no SQL insert path
 * can exercise them. Including it in the default run would mean the common case
 * (`npm test`, no stack running) reports a green suite in which those checks
 * quietly did not happen, which is exactly the failure this arrangement exists
 * to prevent. It is run by `npm run test:storage`, in the CI job that already
 * has a stack, where it refuses to skip.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'db',
          environment: 'node',
          include: ['tests/db/**/*.test.ts'],
          globalSetup: ['tests/db/helpers/global-setup.ts'],
          // One PostgreSQL server is shared by the whole project; each test
          // file clones a template database. Running files serially keeps
          // `CREATE DATABASE ... TEMPLATE` free of concurrent-connection races.
          fileParallelism: false,
          pool: 'forks',
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'client',
          // React components and the browser image pipeline. jsdom supplies the
          // document, the event loop and `HTMLCanvasElement`; it does **not**
          // implement 2D rendering or `toBlob`, so the encoder is stubbed in
          // the tests that need it and the assertions are about the arguments
          // the pipeline passes, not about pixels.
          environment: 'jsdom',
          include: ['tests/client/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/client/setup.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'storage',
          environment: 'node',
          include: ['tests/storage/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});

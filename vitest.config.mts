import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcAlias = fileURLToPath(new URL('./src', import.meta.url));

// `server-only` throws unless resolved under the `react-server` export
// condition. Point it at an empty module, exactly as that condition does, so
// server modules can be imported by a test. See tests/stubs/server-only.ts.
const serverOnlyStub = fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url));

const alias = { '@': srcAlias, 'server-only': serverOnlyStub };

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
    ],
  },
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The support address, and the rules about it.
 *
 * `getSupportEmail()` is the only reader of `NEXT_PUBLIC_SUPPORT_EMAIL`, so
 * these assertions cover every surface that shows it: the application footer
 * and both error boundaries.
 */

const ORIGINAL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL;

async function loadEnv() {
  // Re-imported per case because the module reads `process.env` at call time
  // but Vitest caches the module graph between tests.
  vi.resetModules();
  return import('@/lib/env');
}

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_SUPPORT_EMAIL;
});

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.NEXT_PUBLIC_SUPPORT_EMAIL;
  } else {
    process.env.NEXT_PUBLIC_SUPPORT_EMAIL = ORIGINAL;
  }
});

describe('the configured support address', () => {
  it('is returned when set', async () => {
    process.env.NEXT_PUBLIC_SUPPORT_EMAIL = 'help@example.org';
    const { getSupportEmail } = await loadEnv();

    expect(getSupportEmail()).toBe('help@example.org');
  });

  it('is trimmed, so a stray newline in a dashboard field does not break the link', async () => {
    process.env.NEXT_PUBLIC_SUPPORT_EMAIL = '  help@example.org \n';
    const { getSupportEmail } = await loadEnv();

    expect(getSupportEmail()).toBe('help@example.org');
  });

  it('is null when unset, rather than throwing', async () => {
    const { getSupportEmail } = await loadEnv();

    // Deliberately unlike the required variables: a deployment that has not
    // finished being configured should render, not crash on every page.
    expect(getSupportEmail()).toBeNull();
  });

  it('is null when blank', async () => {
    process.env.NEXT_PUBLIC_SUPPORT_EMAIL = '   ';
    const { getSupportEmail } = await loadEnv();

    expect(getSupportEmail()).toBeNull();
  });

  it('rejects a placeholder that is not an address', async () => {
    for (const placeholder of ['TODO', 'changeme', 'support', 'support@', '@example.org']) {
      process.env.NEXT_PUBLIC_SUPPORT_EMAIL = placeholder;
      const { getSupportEmail } = await loadEnv();

      // A dead `mailto:TODO` link silently loses somebody's report, which is
      // worse than showing nothing at all.
      expect(getSupportEmail(), placeholder).toBeNull();
    }
  });

  it('defaults to no address at all', async () => {
    const { getSupportEmail } = await loadEnv();

    // The pilot league is a tenant, not the product. A hard-coded club mailbox
    // would start receiving another league's support mail on day one.
    expect(getSupportEmail()).toBeNull();
  });
});

describe('the support address is not a secret and is not treated as one', () => {
  it('carries the NEXT_PUBLIC_ prefix, so it may reach the browser', async () => {
    // The error boundary that needs it most is a client component. This asserts
    // the variable is named such that Next.js will inline it.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/lib/env.ts', 'utf8'),
    );

    expect(source).toContain('process.env.NEXT_PUBLIC_SUPPORT_EMAIL');
  });
});

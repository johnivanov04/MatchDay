import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `/auth/continue` is willing to send somebody to.
 *
 * The parameter is fully attacker-controllable — anybody can compose
 * `/auth/continue?confirmation_url=https://evil.example` — and the page it
 * lands on is one users have been told to trust, reached from a real-looking
 * sign-in email on our real domain. So the validator is the whole security
 * boundary here, and these cases pin it.
 */

const SUPABASE_URL = 'https://iyhbvmwvkdbwnkzduzmp.supabase.co';

async function loadValidator(supabaseUrl = SUPABASE_URL) {
  vi.resetModules();
  vi.doMock('@/lib/env', () => ({
    getPublicEnv: () => ({
      supabaseUrl,
      supabaseAnonKey: 'anon',
      siteUrl: 'https://match-day-lake.vercel.app',
    }),
  }));
  return import('@/lib/auth/confirmation-url');
}

/** The shape a real Supabase link has — verified against a live instance. */
function confirmationUrl(base = SUPABASE_URL): string {
  return `${base}/auth/v1/verify?token=pkce_abc123&type=magiclink&redirect_to=${encodeURIComponent(
    'https://match-day-lake.vercel.app/auth/callback?next=%2Fdashboard',
  )}`;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('@/lib/env');
  vi.resetModules();
});

describe('a genuine confirmation URL is accepted', () => {
  it('accepts the real Supabase magic-link shape', async () => {
    const { validateConfirmationUrl } = await loadValidator();

    const result = validateConfirmationUrl(confirmationUrl());

    expect(result.ok).toBe(true);
    expect(result.ok && result.url).toContain('/auth/v1/verify');
  });

  it('accepts a signup confirmation, which is what a first-time user gets', async () => {
    // `shouldCreateUser: true` means a brand-new address receives the "Confirm
    // signup" email, whose ConfirmationURL differs only in `type`.
    const { validateConfirmationUrl } = await loadValidator();

    const result = validateConfirmationUrl(
      `${SUPABASE_URL}/auth/v1/verify?token=abc&type=signup&redirect_to=https%3A%2F%2Fexample.test`,
    );

    expect(result.ok).toBe(true);
  });

  it('preserves the query, which carries the token the flow needs', async () => {
    const { validateConfirmationUrl } = await loadValidator();

    const result = validateConfirmationUrl(confirmationUrl());

    expect(result.ok && result.url).toContain('token=pkce_abc123');
    expect(result.ok && result.url).toContain('redirect_to=');
  });

  it('works against a local http Supabase stack', async () => {
    // Derived from configuration rather than hardcoded, so development keeps
    // working without loosening anything in production.
    const local = 'http://127.0.0.1:54321';
    const { validateConfirmationUrl } = await loadValidator(local);

    expect(validateConfirmationUrl(confirmationUrl(local)).ok).toBe(true);
  });
});

describe('anything else is rejected', () => {
  it('rejects a missing parameter', async () => {
    const { validateConfirmationUrl } = await loadValidator();

    for (const value of [null, undefined, '', '   ']) {
      const result = validateConfirmationUrl(value);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe('missing');
    }
  });

  it('rejects a malformed URL', async () => {
    const { validateConfirmationUrl } = await loadValidator();

    for (const value of ['not a url', 'https://', '://missing-scheme', '%%%']) {
      const result = validateConfirmationUrl(value);
      expect(result.ok, value).toBe(false);
    }
  });

  it('rejects an entirely different origin', async () => {
    const { validateConfirmationUrl } = await loadValidator();

    const result = validateConfirmationUrl('https://evil.example/auth/v1/verify?token=abc');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('wrong_origin');
  });

  it('rejects a lookalike host', async () => {
    const { validateConfirmationUrl } = await loadValidator();

    for (const host of [
      'https://iyhbvmwvkdbwnkzduzmp.supabase.co.evil.example',
      'https://evil.example/iyhbvmwvkdbwnkzduzmp.supabase.co',
      'https://iyhbvmwvkdbwnkzduzmp-supabase.co',
      'https://another-project.supabase.co',
    ]) {
      const result = validateConfirmationUrl(`${host}/auth/v1/verify?token=abc`);
      expect(result.ok, host).toBe(false);
    }
  });

  it('rejects a different port on the right host', async () => {
    const { validateConfirmationUrl } = await loadValidator('http://127.0.0.1:54321');

    const result = validateConfirmationUrl('http://127.0.0.1:9999/auth/v1/verify?token=abc');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('wrong_origin');
  });

  it('rejects http when the project is configured as https', async () => {
    const { validateConfirmationUrl } = await loadValidator();

    const result = validateConfirmationUrl(
      'http://iyhbvmwvkdbwnkzduzmp.supabase.co/auth/v1/verify?token=abc',
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('insecure_protocol');
  });

  it('rejects a scheme that could execute, before anything else', async () => {
    const { validateConfirmationUrl } = await loadValidator();

    for (const value of [
      'javascript:alert(document.cookie)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'file:///etc/passwd',
    ]) {
      const result = validateConfirmationUrl(value);
      expect(result.ok, value).toBe(false);
      // These must never reach an href, whatever else is wrong with them.
      expect(!result.ok && result.reason, value).toBe('insecure_protocol');
    }
  });

  it('rejects the right origin with the wrong path', async () => {
    const { validateConfirmationUrl } = await loadValidator();

    for (const path of [
      '/auth/v1/authorize',
      '/rest/v1/leagues',
      '/auth/v1/verify/extra',
      '/',
      '/auth/v1/logout',
    ]) {
      const result = validateConfirmationUrl(`${SUPABASE_URL}${path}?token=abc`);
      expect(result.ok, path).toBe(false);
      expect(!result.ok && result.reason, path).toBe('wrong_path');
    }
  });

  it('is not fooled by traversal that resolves off the verify path', async () => {
    const { validateConfirmationUrl } = await loadValidator();

    const result = validateConfirmationUrl(
      `${SUPABASE_URL}/auth/v1/verify/../../../rest/v1/leagues?token=abc`,
    );

    expect(result.ok).toBe(false);
  });

  it('rejects an open-redirect attempt smuggled through userinfo', async () => {
    const { validateConfirmationUrl } = await loadValidator();

    // `https://project.supabase.co@evil.example/…` has host evil.example.
    const result = validateConfirmationUrl(
      'https://iyhbvmwvkdbwnkzduzmp.supabase.co@evil.example/auth/v1/verify?token=abc',
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('wrong_origin');
  });
});

import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/auth/continue` must render without spending the token.
 *
 * The page exists because things other than the recipient open sign-in links —
 * Brevo's click tracker, mail scanners, inbox previewers. If rendering the page
 * itself verified the token, or redirected onward, or fetched the confirmation
 * URL, it would burn the link exactly as the tracker does and be worse than
 * useless.
 *
 * So the assertions below are mostly about what does *not* happen. Every
 * Supabase client factory and every Next navigation helper is spied on, and the
 * page must touch none of them.
 */

const SUPABASE_URL = 'https://iyhbvmwvkdbwnkzduzmp.supabase.co';

const mocks = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAnonClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));
vi.mock('@/lib/supabase/anon', () => ({
  createSupabaseAnonClient: mocks.createSupabaseAnonClient,
}));
vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
  isServiceRoleConfigured: () => true,
}));
vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
  permanentRedirect: mocks.permanentRedirect,
}));
vi.mock('@/lib/env', () => ({
  getPublicEnv: () => ({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: 'anon',
    siteUrl: 'https://match-day-lake.vercel.app',
  }),
  getSupportEmail: () => null,
  getSiteUrl: () => 'https://match-day-lake.vercel.app',
}));

const { default: AuthContinuePage } = await import('@/app/auth/continue/page');

const VALID = `${SUPABASE_URL}/auth/v1/verify?token=pkce_abc123&type=magiclink&redirect_to=https%3A%2F%2Fexample.test`;

function render(confirmationUrl?: string) {
  return AuthContinuePage({
    searchParams: Promise.resolve(
      confirmationUrl === undefined ? {} : { confirmation_url: confirmationUrl },
    ),
  });
}

/**
 * The page's actual HTML.
 *
 * `renderToStaticMarkup` rather than inspecting the element tree: what matters
 * is what reaches the browser, and an href that is present in the tree but
 * never rendered would be a false positive in both directions.
 */
async function html(confirmationUrl?: string): Promise<string> {
  const tree = await render(confirmationUrl);
  return renderToStaticMarkup(tree as ReactElement);
}

/** A file's source with comments removed, so prose cannot satisfy a code scan. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rendering does not consume the one-time token', () => {
  it('creates no Supabase client of any kind', async () => {
    await render(VALID);

    // No client means no verifyOtp and no exchangeCodeForSession — the two
    // calls that would spend the token — are even reachable.
    expect(mocks.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocks.createSupabaseAnonClient).not.toHaveBeenCalled();
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it('never fetches the confirmation URL', async () => {
    await render(VALID);

    // Fetching it server-side would consume the token just as surely as a
    // scanner doing it.
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('never redirects', async () => {
    await render(VALID);

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.permanentRedirect).not.toHaveBeenCalled();
  });

  it('returns markup rather than throwing a navigation signal', async () => {
    // `redirect()` works by throwing NEXT_REDIRECT. Resolving normally proves
    // no navigation was triggered.
    await expect(render(VALID)).resolves.toBeTruthy();
  });

  it('emits no meta refresh', async () => {
    const markup = await html(VALID);

    expect(markup).not.toContain('http-equiv');
    expect(markup).not.toContain('refresh');
  });

  it('is a server component with no client entry point', async () => {
    // Comments are stripped first: the page's own documentation explains why it
    // has no `useEffect` and no `<meta http-equiv="refresh">`, and a naive
    // substring scan would match that prose and pass or fail for the wrong
    // reason. What is under test is the code.
    const code = codeOf('src/app/auth/continue/page.tsx');

    expect(code).not.toContain("'use client'");
    expect(code).not.toContain('useEffect');
    expect(code).not.toContain('useRouter');
    expect(code).not.toContain('router.push');
    expect(code).not.toContain('http-equiv');
    expect(code).not.toContain('redirect(');
  });

  it('does not use next/link for the confirmation anchor, which would prefetch', async () => {
    const code = codeOf('src/app/auth/continue/page.tsx');

    // next/link prefetches on hover and on entering the viewport. Pointing it
    // at the confirmation URL would recreate the exact bug this page fixes.
    // `<Link>` is still used for the internal /sign-in links, which is fine.
    expect(code).not.toMatch(/<Link[^>]*href=\{result\.url\}/);
    expect(code).toMatch(/<a[\s\S]*href=\{result\.url\}/);
  });
});

describe('the valid case renders an explicit human action', () => {
  it('renders the confirmation URL as the anchor target', async () => {
    const markup = await html(VALID);

    expect(markup).toContain('/auth/v1/verify');
    expect(markup).toContain('Continue sign in');
  });

  it('asks crawlers not to follow it', async () => {
    const markup = await html(VALID);

    expect(markup).toContain('nofollow');
  });
});

describe('an unusable link produces a safe error state', () => {
  const bad: Array<[string, string | undefined]> = [
    ['missing', undefined],
    ['blank', ''],
    ['malformed', 'not a url'],
    ['external origin', 'https://evil.example/auth/v1/verify?token=abc'],
    ['wrong path', `${SUPABASE_URL}/rest/v1/leagues?token=abc`],
    ['javascript scheme', 'javascript:alert(1)'],
    ['userinfo smuggling', `https://${SUPABASE_URL.slice(8)}@evil.example/auth/v1/verify`],
  ];

  it.each(bad)('renders the error state for %s', async (_label, value) => {
    const markup = await html(value);

    expect(markup).toContain('not valid');
    expect(markup).toContain('/sign-in');
  });

  it.each(bad)('renders no clickable link to %s', async (_label, value) => {
    const markup = await html(value);

    // The rejected value must not appear as an href — that is the open-redirect
    // failure mode.
    expect(markup).not.toContain('evil.example');
    expect(markup).not.toContain('javascript:');
    expect(markup).not.toContain('/auth/v1/verify');
  });

  it('does not echo the rejected parameter back to the page', async () => {
    const markup = await html('https://evil.example/steal?token=secret-token-value');

    // Reflecting it would be both a reflected-XSS surface and a way to probe
    // what the validator accepts.
    expect(markup).not.toContain('secret-token-value');
    expect(markup).not.toContain('evil.example');
  });

  it('still creates no Supabase client and never redirects', async () => {
    await render('https://evil.example/auth/v1/verify?token=abc');

    expect(mocks.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

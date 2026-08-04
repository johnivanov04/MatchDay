/**
 * Environment access.
 *
 * Two rules shape this file:
 *
 * 1. `NEXT_PUBLIC_*` variables must be read as literal `process.env.NAME`
 *    expressions for Next.js to inline them into the client bundle. A dynamic
 *    lookup such as `process.env[name]` silently yields `undefined` in the
 *    browser.
 * 2. Validation happens when a value is *used*, not when this module loads, so
 *    that `next build` succeeds in an environment (like CI) that has no real
 *    Supabase credentials.
 */

const PUBLIC_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
} as const;

export interface PublicEnv {
  supabaseUrl: string;
  supabaseAnonKey: string;
  siteUrl: string;
}

function required(name: keyof typeof PUBLIC_ENV): string {
  const value = PUBLIC_ENV[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/**
 * Supabase URL and anon key. Both are safe in the browser: the anon key grants
 * nothing on its own, because Row Level Security is what protects the data.
 */
export function getPublicEnv(): PublicEnv {
  return {
    supabaseUrl: required('NEXT_PUBLIC_SUPABASE_URL'),
    supabaseAnonKey: required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    siteUrl: required('NEXT_PUBLIC_SITE_URL'),
  };
}

/**
 * The origin used to build magic-link and one-time-code redirects.
 *
 * Taken from configuration rather than from the request's Host header: an
 * attacker who can set that header could otherwise redirect a sign-in link to
 * a host they control.
 */
export function getSiteUrl(): string {
  return required('NEXT_PUBLIC_SITE_URL').replace(/\/+$/, '');
}

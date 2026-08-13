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

/**
 * Where somebody the product has blocked can reach a human.
 *
 * OPTIONAL, AND NULL WHEN UNSET — unlike everything above, this does not throw.
 * A missing support address is a deployment that has not finished being
 * configured, not one that should refuse to render; the alternative is a
 * product that crashes on every page because nobody filled in an email
 * address.
 *
 * DELIBERATELY NOT DEFAULTED to an RMVFC address, or any address. The pilot
 * league is the first tenant, not the product, and a hard-coded club mailbox
 * would start receiving another league's support mail the moment a second one
 * signs up.
 *
 * Read as a literal `process.env.NAME` expression so Next.js inlines it into
 * the client bundle — the error boundary that needs it most is a client
 * component. It is an address an operator chose to publish, so it carries no
 * secret.
 */
export function getSupportEmail(): string | null {
  const value = process.env.NEXT_PUBLIC_SUPPORT_EMAIL;
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  // A bare `user@host` shape. Enough to keep a stray placeholder like "TODO"
  // from rendering as a broken mailto link that quietly loses somebody's
  // report; not an attempt to validate deliverability.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : null;
}

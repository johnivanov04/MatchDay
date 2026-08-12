import type { BrowserContext, Cookie } from '@playwright/test';
import { readSupabaseEnvironment } from './environment';

/**
 * Signing a test in, without a magic link and without a backdoor.
 *
 * The application has no test-only route, no impersonation parameter and no
 * bypass. This mints a **real** Supabase session through the Auth API — the
 * same admin endpoint the magic-link mailer uses, followed by the same
 * verification the link performs — and installs the resulting cookie in the
 * browser. Everything after that is genuine: a real JWT, real `auth.uid()`,
 * real Row Level Security, real server actions.
 *
 * The alternative, driving Mailpit, would make every test depend on scraping an
 * inbox and on the PKCE code verifier surviving between two browser contexts.
 * This is the same authentication with the mail round trip removed.
 *
 * @see e2e/support/environment.ts — where the keys come from (never a file).
 */

interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

/**
 * Cookie name @supabase/ssr derives from the project URL.
 *
 * For `http://127.0.0.1:54321` the reference is the first hostname label, so
 * the cookie is `sb-127-auth-token`. Computed rather than hard-coded so a
 * different local port or a hosted URL still works.
 */
function storageKeyFor(apiUrl: string): string {
  const { hostname } = new URL(apiUrl);
  const reference = hostname.split('.')[0] ?? hostname;
  return `sb-${reference}-auth-token`;
}

/**
 * Retries a request to the Auth API through a transient server-side failure.
 *
 * The local Supabase stack runs GoTrue and PostgreSQL in Docker, and GoTrue
 * opens a fresh PostgreSQL connection per request rather than pooling. Under
 * the load a parallel browser suite produces it periodically exhausts the
 * bridge network's ephemeral ports and answers 5xx with
 * `cannot assign requested address`. The condition clears in tens of
 * milliseconds.
 *
 * This is local-stack capacity, not an application fault, and it is not
 * something a test should be allowed to report as a product failure. A 4xx is
 * never retried — that would hide a genuinely bad request.
 */
async function withTransientRetry(
  describe: string,
  attempt: () => Promise<Response>,
): Promise<Response> {
  const MAX_ATTEMPTS = 5;
  let lastStatus = 0;

  for (let tries = 0; tries < MAX_ATTEMPTS; tries += 1) {
    const response = await attempt().catch(() => null);

    if (response !== null && response.ok) {
      return response;
    }
    if (response !== null && response.status < 500) {
      return response;
    }

    lastStatus = response?.status ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** tries));
  }

  throw new Error(
    `${describe} kept failing (last status ${String(lastStatus)}). ` +
      'The local Supabase Auth container may be saturated; `npx supabase restart` clears it.',
  );
}

async function mintSession(email: string): Promise<AuthSession> {
  const { apiUrl, anonKey, serviceRoleKey } = readSupabaseEnvironment();

  const linkResponse = await withTransientRetry(`generate_link for ${email}`, () =>
    fetch(`${apiUrl}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'magiclink', email }),
    }),
  );

  if (!linkResponse.ok) {
    throw new Error(`Could not generate a sign-in link for ${email}: ${linkResponse.status}`);
  }

  const link = (await linkResponse.json()) as { hashed_token?: string };
  if (link.hashed_token === undefined) {
    throw new Error(`No token returned for ${email}. Does that account exist in auth.users?`);
  }

  const verifyResponse = await withTransientRetry(`verify for ${email}`, () =>
    fetch(`${apiUrl}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', token_hash: link.hashed_token }),
    }),
  );

  const session = (await verifyResponse.json()) as Partial<AuthSession>;
  if (session.access_token === undefined || session.refresh_token === undefined) {
    throw new Error(`Verification failed for ${email}.`);
  }

  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
  };
}

/**
 * The cookie value shape `@supabase/ssr` reads back.
 *
 * It stores a base64url-encoded JSON session behind a `base64-` marker, and
 * chunks anything over ~3180 bytes across `<name>.0`, `<name>.1`, … A real
 * Supabase JWT plus a user object exceeds that, so the chunking is not optional.
 */
function sessionCookies(name: string, session: AuthSession, domain: string): Cookie[] {
  const payload = JSON.stringify(session);
  const encoded = `base64-${Buffer.from(payload, 'utf8').toString('base64url')}`;

  const CHUNK = 3180;
  const values: string[] = [];
  for (let index = 0; index < encoded.length; index += CHUNK) {
    values.push(encoded.slice(index, index + CHUNK));
  }

  const base = {
    domain,
    path: '/',
    httpOnly: false,
    secure: false,
    sameSite: 'Lax' as const,
    expires: Math.floor(Date.now() / 1000) + 3600,
  };

  return values.length === 1
    ? [{ name, value: values[0]!, ...base }]
    : values.map((value, index) => ({ name: `${name}.${String(index)}`, value, ...base }));
}

/**
 * Signs `context` in as `email` for the remainder of its life.
 *
 * Call before the first navigation. The account must already exist in
 * `auth.users` — either a seeded fixture or one created by the data factory.
 */
export async function signInAs(context: BrowserContext, email: string): Promise<void> {
  const { apiUrl } = readSupabaseEnvironment();
  const session = await mintSession(email);
  const baseUrl = process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:3100';

  await context.addCookies(
    sessionCookies(storageKeyFor(apiUrl), session, new URL(baseUrl).hostname),
  );
}

/** Drops the session, leaving the context signed out. */
export async function signOut(context: BrowserContext): Promise<void> {
  await context.clearCookies();
}

import { SEED_USERS, type SeedUser } from '../../db/helpers/harness';

/**
 * Reaching a real Supabase Storage service, and refusing to pretend otherwise.
 *
 * ── WHY THIS SUITE EXISTS SEPARATELY ───────────────────────────────────────
 *
 * Half the avatar contract is not in the database. `allowed_mime_types` and
 * `file_size_limit` are columns on `storage.buckets`, but they are read by the
 * Storage **service** when a file is uploaded — never by a constraint, never by
 * a policy. A direct SQL insert bypasses both by design. The same goes for the
 * public object endpoint, which serves a public bucket without consulting Row
 * Level Security at all: no SQL test can tell you whether a signed-out browser
 * can fetch an avatar.
 *
 * So these tests speak HTTP to a running stack. They are the only place those
 * guarantees are checked anywhere in the repository.
 *
 * ── AND WHY THEY CANNOT QUIETLY SKIP ───────────────────────────────────────
 *
 * A suite that skips when its dependency is missing is a reasonable local
 * convenience and an unacceptable CI outcome: the job goes green having
 * verified nothing, and the failure mode is invisible precisely when it matters
 * — a MIME allowlist that silently stopped being enforced looks exactly like
 * one that was never tested.
 *
 * The rule is therefore: **`CI` set means the stack is mandatory.** Not an
 * opt-in flag somebody has to remember to pass in a workflow file, because
 * forgetting it is the whole failure mode. `REQUIRE_STORAGE_TESTS=1` exists on
 * top of that for a developer who wants the same strictness locally.
 */

export interface LocalStack {
  readonly apiUrl: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
}

/** True when a missing stack must fail the run rather than skip it. */
export const STACK_REQUIRED =
  process.env['CI'] !== undefined || process.env['REQUIRE_STORAGE_TESTS'] === '1';

const MISSING_STACK =
  'The Supabase Storage tests need a running local stack.\n' +
  'Run `npx supabase start && npm run db:reset`, or set E2E_SUPABASE_URL, ' +
  'E2E_SUPABASE_ANON_KEY and E2E_SUPABASE_SERVICE_ROLE_KEY.\n' +
  'This is a hard failure because CI is set: these tests are the only place ' +
  'the bucket MIME allowlist, the size cap and public object retrieval are ' +
  'checked, and a skipped run would report them as fine.';

/**
 * Resolves the stack, or `null` when it is not running.
 *
 * Reads the same `E2E_*` variables the Playwright suite uses, so a CI job that
 * has already captured them from `supabase status` passes them straight
 * through rather than shelling out to the CLI again.
 */
export async function resolveStack(): Promise<LocalStack | null> {
  const apiUrl = process.env['E2E_SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
  const anonKey = process.env['E2E_SUPABASE_ANON_KEY'];
  const serviceRoleKey = process.env['E2E_SUPABASE_SERVICE_ROLE_KEY'];

  const resolved =
    anonKey !== undefined && serviceRoleKey !== undefined
      ? { apiUrl, anonKey, serviceRoleKey }
      : await readFromCli(apiUrl);

  if (resolved === null) {
    if (STACK_REQUIRED) {
      throw new Error(MISSING_STACK);
    }
    return null;
  }

  // Reachability, and the bucket specifically: a stack that is up but has not
  // had migrations applied would otherwise produce a wall of 404s that look
  // like policy failures.
  const probe = await fetch(`${resolved.apiUrl}/storage/v1/bucket/avatars`, {
    headers: { apikey: resolved.serviceRoleKey, Authorization: `Bearer ${resolved.serviceRoleKey}` },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);

  if (probe === null || !probe.ok) {
    if (STACK_REQUIRED) {
      throw new Error(
        `${MISSING_STACK}\nThe stack answered ${String(probe?.status ?? 'nothing')} for the avatars bucket.`,
      );
    }
    return null;
  }

  return resolved;
}

async function readFromCli(apiUrl: string): Promise<LocalStack | null> {
  const { execFileSync } = await import('node:child_process');
  try {
    const raw = execFileSync('npx', ['supabase', 'status', '-o', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) {
      return null;
    }
    const status = JSON.parse(raw.slice(start, end + 1)) as {
      API_URL?: string;
      ANON_KEY?: string;
      SERVICE_ROLE_KEY?: string;
    };
    if (status.ANON_KEY === undefined || status.SERVICE_ROLE_KEY === undefined) {
      return null;
    }
    return {
      apiUrl: status.API_URL ?? apiUrl,
      anonKey: status.ANON_KEY,
      serviceRoleKey: status.SERVICE_ROLE_KEY,
    };
  } catch {
    return null;
  }
}

/**
 * A genuine access token for a seeded user.
 *
 * Minted through GoTrue's admin link endpoint and then verified, which is the
 * same pair of calls a magic link performs — so the token is signed by the real
 * issuer, carries real claims, and is validated by the Storage service exactly
 * as a browser's would be. Nothing here forges a JWT or borrows a secret; an
 * authorization result from these tests is a result about production behaviour.
 */
export async function accessTokenFor(stack: LocalStack, user: SeedUser): Promise<string> {
  const link = await fetch(`${stack.apiUrl}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      apikey: stack.serviceRoleKey,
      Authorization: `Bearer ${stack.serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'magiclink', email: user.email }),
  });

  if (!link.ok) {
    throw new Error(`Could not generate a sign-in link for the seeded user: ${String(link.status)}`);
  }

  const { hashed_token: hashedToken } = (await link.json()) as { hashed_token?: string };
  if (hashedToken === undefined) {
    throw new Error('GoTrue returned no token. Has `npm run db:reset` been run?');
  }

  const verified = await fetch(`${stack.apiUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: stack.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashedToken }),
  });

  const session = (await verified.json()) as { access_token?: string };
  if (session.access_token === undefined) {
    throw new Error('GoTrue would not issue a session for the seeded user.');
  }
  return session.access_token;
}

export const OWNER: SeedUser = SEED_USERS.multiLeaguePlayer;
export const OTHER: SeedUser = SEED_USERS.rmvfcPlayer;

/**
 * A minimal but genuine JPEG: SOI, a JFIF APP0 segment, and EOI.
 *
 * `Blob` rather than `Buffer` or `Uint8Array` because that is what `fetch`
 * accepts as a body under this project's DOM lib types.
 */
export function jpegBlob(padding = 240): Blob {
  const bytes = new Uint8Array(20 + Math.max(padding, 0));
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01], 0);
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return new Blob([bytes]);
}

/** A distinct object name per call, so no test depends on another's cleanup. */
export function uniqueObjectName(userId: string): string {
  const uuid = crypto.randomUUID();
  return `${userId}/${uuid}.jpg`;
}

import { randomUUID } from 'node:crypto';
import { Client, Pool, type PoolClient } from 'pg';
import { inject } from 'vitest';

/**
 * Fixtures from `supabase/seed.sql`. Referenced by ID so a test failure points
 * at a specific seeded person rather than at "the second row".
 */
export const SEED_USERS = {
  rmvfcAdmin: { id: '11111111-1111-4111-8111-000000000001', email: 'admin.rmvfc@matchday.test' },
  fivesAdmin: { id: '11111111-1111-4111-8111-000000000002', email: 'admin.fives@matchday.test' },
  /** Belongs to BOTH leagues — the multi-league player required by Phase 1. */
  multiLeaguePlayer: {
    id: '11111111-1111-4111-8111-000000000003',
    email: 'player.multi@matchday.test',
  },
  rmvfcPlayer: { id: '11111111-1111-4111-8111-000000000004', email: 'player.rmvfc@matchday.test' },
  pendingPlayer: {
    id: '11111111-1111-4111-8111-000000000005',
    email: 'player.pending@matchday.test',
  },
  suspendedPlayer: {
    id: '11111111-1111-4111-8111-000000000006',
    email: 'player.suspended@matchday.test',
  },
  removedPlayer: {
    id: '11111111-1111-4111-8111-000000000007',
    email: 'player.removed@matchday.test',
  },
  /** Holds no membership anywhere. */
  outsider: { id: '11111111-1111-4111-8111-000000000008', email: 'outsider@matchday.test' },
} as const;

export const SEED_LEAGUES = {
  rmvfc: '22222222-2222-4222-8222-000000000001',
  weeknightFives: '22222222-2222-4222-8222-000000000002',
} as const;

export const SEED_MEMBERSHIPS = {
  rmvfcAdmin: '33333333-3333-4333-8333-000000000001',
  rmvfcMultiLeaguePlayer: '33333333-3333-4333-8333-000000000002',
  rmvfcPlayer: '33333333-3333-4333-8333-000000000003',
  rmvfcSuspended: '33333333-3333-4333-8333-000000000004',
  rmvfcRemoved: '33333333-3333-4333-8333-000000000005',
  fivesAdmin: '33333333-3333-4333-8333-000000000011',
  fivesMultiLeaguePlayer: '33333333-3333-4333-8333-000000000012',
  fivesPending: '33333333-3333-4333-8333-000000000013',
} as const;

/** Phase 2 fixtures. */
export const SEED_JOIN_REQUESTS = {
  /** `outsider` → Weeknight 5v5, still pending. */
  outsiderToFives: '66666666-6666-4666-8666-000000000001',
} as const;

export const SEED_INVITES = {
  /** A live invitation to the private RMVFC league. */
  rmvfc: '77777777-7777-4777-8777-000000000001',
} as const;

/**
 * The raw token behind `SEED_INVITES.rmvfc`. Public by design — the seed stores
 * only its SHA-256 digest, exactly as `create_league_invite()` does.
 */
export const SEED_INVITE_TOKEN = 'matchday-local-development-invite-token-0001';

/** Phase 3 fixtures. */
export const SEED_GUIDELINES = {
  /** RMVFC, published, requires acceptance. */
  rmvfcRequired: '88888888-8888-4888-8888-000000000001',
  /** Weeknight 5v5, published, informational only. */
  fivesInformational: '88888888-8888-4888-8888-000000000002',
} as const;

export const SEED_TEMPLATES = {
  rmvfcMonday: '99999999-9999-4999-8999-000000000001',
  rmvfcWednesday: '99999999-9999-4999-8999-000000000002',
  fivesThursday: '99999999-9999-4999-8999-000000000011',
} as const;

export const SEED_MATCHES = {
  rmvfcOpen: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  rmvfcDraft: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
  fivesOpen: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000011',
} as const;

export interface SeedUser {
  readonly id: string;
  readonly email: string;
}

export interface TestDatabase {
  readonly name: string;
  readonly pool: Pool;
  drop(): Promise<void>;
}

/**
 * Clones one of the templates built in global setup into a database owned by
 * the calling test file. Cloning is near-instant and gives every file a fully
 * isolated server-side state, so no test can be affected by another's writes.
 *
 * @param kind `'seeded'` includes `supabase/seed.sql`; `'schema'` is empty.
 */
export async function createTestDatabase(kind: 'schema' | 'seeded'): Promise<TestDatabase> {
  const connection = inject('matchdayDb');
  const template = kind === 'seeded' ? connection.seededTemplate : connection.schemaTemplate;
  const name = `matchday_test_${randomUUID().replaceAll('-', '')}`;

  const maintenance = new Client({
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: connection.maintenanceDatabase,
  });
  await maintenance.connect();
  try {
    await maintenance.query(`create database ${name} template ${template}`);
  } finally {
    await maintenance.end();
  }

  const pool = new Pool({
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: name,
    max: 4,
  });

  return {
    name,
    pool,
    async drop() {
      await pool.end();
      const cleanup = new Client({
        host: connection.host,
        port: connection.port,
        user: connection.user,
        password: connection.password,
        database: connection.maintenanceDatabase,
      });
      await cleanup.connect();
      try {
        await cleanup.query(`drop database if exists ${name} with (force)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

async function inRole<T>(
  db: TestDatabase,
  role: 'anon' | 'authenticated' | 'service_role',
  claims: Record<string, unknown> | null,
  fn: (client: PoolClient) => Promise<T>,
  commit = false,
): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    if (claims !== null) {
      // `set_config(..., is_local => true)` is exactly how PostgREST hands the
      // verified JWT to PostgreSQL. It is scoped to this transaction.
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify(claims),
      ]);
    }
    await client.query(`set local role ${role}`);
    const result = await fn(client);
    if (commit) {
      // Reset the role first: COMMIT itself is unrestricted, but the deferred
      // constraint triggers that fire during it must not run as `authenticated`.
      await client.query('reset role');
      await client.query('commit');
    }
    return result;
  } finally {
    // Roll back unless the caller asked to commit: an RLS probe must never
    // leave residue for the next test, and a write that is *expected* to
    // succeed is asserted inside the transaction before it is discarded.
    try {
      await client.query('rollback');
    } catch {
      /* already committed, or the transaction was aborted by the failure under test */
    }
    client.release();
  }
}

/**
 * Runs `fn` as a signed-in user, exactly as a PostgREST request would: role
 * `authenticated`, with `request.jwt.claims` carrying the verified identity.
 * Everything inside is rolled back.
 */
export async function asUser<T>(
  db: TestDatabase,
  user: SeedUser,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return inRole(db, 'authenticated', {
    sub: user.id,
    email: user.email,
    role: 'authenticated',
    aud: 'authenticated',
  }, fn);
}

/**
 * As `asUser`, but COMMITs instead of rolling back.
 *
 * Needed wherever the behaviour under test only happens at COMMIT — the
 * deferred single-administrator constraint, most importantly. A test that
 * always rolled back would never fire it and would pass whether or not the
 * constraint existed. Use a per-test database with this.
 */
export async function asUserCommitting<T>(
  db: TestDatabase,
  user: SeedUser,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return inRole(
    db,
    'authenticated',
    { sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated' },
    fn,
    true,
  );
}

/** Runs `fn` as an unauthenticated visitor (role `anon`, no claims). */
export async function asAnon<T>(
  db: TestDatabase,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return inRole(db, 'anon', null, fn);
}

/** Runs `fn` with the RLS-bypassing service role, as trusted server code would. */
export async function asServiceRole<T>(
  db: TestDatabase,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return inRole(db, 'service_role', null, fn);
}

/**
 * As `asServiceRole`, but COMMITs.
 *
 * Needed wherever a later assertion reads the result back on a different
 * connection — the delivery-bookkeeping tests, mainly, where the point is what
 * persisted rather than what one transaction saw.
 */
export async function asServiceRoleCommitting<T>(
  db: TestDatabase,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return inRole(db, 'service_role', null, fn, true);
}

export interface CapturedDatabaseError {
  code: string;
  message: string;
}

function isDatabaseError(error: unknown): error is { code?: unknown; message?: unknown } {
  return typeof error === 'object' && error !== null;
}

/**
 * Asserts that `fn` rejects, and returns the PostgreSQL error for inspection.
 * Fails loudly when the operation unexpectedly succeeds — a security test that
 * silently passes because nothing happened is worse than no test.
 */
export async function expectDatabaseError(fn: () => Promise<unknown>): Promise<CapturedDatabaseError> {
  try {
    await fn();
  } catch (error: unknown) {
    if (isDatabaseError(error)) {
      return {
        code: typeof error.code === 'string' ? error.code : '',
        message: typeof error.message === 'string' ? error.message : String(error),
      };
    }
    return { code: '', message: String(error) };
  }
  throw new Error('Expected the database operation to fail, but it succeeded.');
}

/** PostgreSQL SQLSTATE codes asserted throughout the suite. */
export const PG_ERROR = {
  uniqueViolation: '23505',
  checkViolation: '23514',
  foreignKeyViolation: '23503',
  insufficientPrivilege: '42501',
  notNullViolation: '23502',
} as const;

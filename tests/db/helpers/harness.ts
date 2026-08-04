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
    return await fn(client);
  } finally {
    // Always roll back: an RLS probe must never leave residue for the next
    // test, and a write that is *expected* to succeed is asserted inside the
    // transaction before it is discarded.
    try {
      await client.query('rollback');
    } catch {
      /* the transaction was already aborted by the failure under test */
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

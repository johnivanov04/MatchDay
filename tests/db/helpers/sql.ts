import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';

export const REPO_ROOT = new URL('../../../', import.meta.url).pathname;
export const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');
export const SEED_FILE = join(REPO_ROOT, 'supabase', 'seed.sql');
export const AUTH_SHIM_FILE = join(REPO_ROOT, 'tests', 'db', 'helpers', 'auth-shim.sql');

/**
 * Migration filenames in the order Supabase applies them: lexicographic by the
 * leading timestamp. Exported so a test can assert the ordering is stable and
 * that every file follows the `<timestamp>_<name>.sql` convention.
 */
export function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

export function readSqlFile(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Applies the Supabase-compatibility shim used only by the test harness. */
export async function applyAuthShim(client: Client): Promise<void> {
  await client.query(readSqlFile(AUTH_SHIM_FILE));
}

/**
 * Applies every migration, in order, exactly as written. Each file runs in its
 * own transaction so a failure names the migration that broke.
 */
export async function applyMigrations(client: Client): Promise<void> {
  for (const file of listMigrationFiles()) {
    const sql = readSqlFile(join(MIGRATIONS_DIR, file));
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw new Error(
        `Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

/**
 * Applies `supabase/seed.sql` verbatim. The file manages its own transaction
 * because the single-active-admin constraint is deferred to COMMIT.
 */
export async function applySeed(client: Client): Promise<void> {
  await client.query(readSqlFile(SEED_FILE));
}

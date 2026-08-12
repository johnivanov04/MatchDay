import { Client } from 'pg';
import { readSupabaseEnvironment } from './support/environment';

/**
 * Verifies the world before a single test runs.
 *
 * It checks rather than resets. `supabase db reset` takes the better part of a
 * minute and would make an already slow suite slower on every invocation, and
 * — more importantly — the suite does not need it: every spec builds its own
 * league, members and matches, so a database with previous runs' data in it is
 * still a correct starting point.
 *
 * What it must not tolerate is a database with no schema or no seed, because
 * every spec would then fail with something obscure. So the checks below are
 * deliberately loud and specific about the fix.
 */
export default async function globalSetup(): Promise<void> {
  const { databaseUrl, apiUrl } = readSupabaseEnvironment();

  const client = new Client(databaseUrl);
  try {
    await client.connect();
  } catch {
    throw new Error(
      `Could not reach PostgreSQL at ${databaseUrl}.\n` +
        'Run `npx supabase start` before `npm run test:e2e`.',
    );
  }

  try {
    const { rows: migrations } = await client.query<{ present: boolean }>(
      `select exists (
         select 1 from information_schema.tables
          where table_schema = 'public' and table_name = 'match_signups'
       ) as present`,
    );
    if (migrations[0]?.present !== true) {
      throw new Error(
        'The database is missing Phase 4 tables. Run `npm run db:reset` before the E2E suite.',
      );
    }

    const { rows: functions } = await client.query<{ present: boolean }>(
      `select exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'cancel_spot'
       ) as present`,
    );
    if (functions[0]?.present !== true) {
      throw new Error(
        'The database is missing Phase 5 functions. Run `npm run db:reset` before the E2E suite.',
      );
    }

    const { rows: seed } = await client.query<{ count: string }>(
      `select count(*)::text as count from public.leagues where slug = 'rmv-football-club'`,
    );
    if (seed[0]?.count === '0') {
      throw new Error(
        'The seed data is missing. Run `npm run db:reset`, which applies migrations and the seed.',
      );
    }
  } finally {
    await client.end();
  }

  // The Auth API has to answer too, or every sign-in fixture fails with a
  // network error rather than something that names the cause.
  //
  // Worth knowing when this starts failing mid-suite rather than here: GoTrue
  // opens a PostgreSQL connection per request and does not pool, and the
  // application validates the session against it on every render. Across
  // several full runs on one container it exhausts the Docker bridge's
  // ephemeral ports and answers 5xx with `cannot assign requested address`.
  // `npm run test:e2e:fresh` (or any `npm run db:reset`, which restarts the
  // containers) clears it. It is stack capacity, not an application fault.
  const health = await fetch(`${apiUrl}/auth/v1/health`).catch(() => null);
  if (health === null || !health.ok) {
    throw new Error(`The Supabase Auth API at ${apiUrl} is not responding. Is the stack running?`);
  }
}

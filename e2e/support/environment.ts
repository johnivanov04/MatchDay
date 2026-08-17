import { execFileSync } from 'node:child_process';

/**
 * Where the local Supabase stack is and how to talk to it.
 *
 * Keys are read from `supabase status -o json` rather than written into any
 * file. They are local development credentials that the CLI regenerates, but
 * the repository's rule is that a key never appears in source, and a test file
 * is source.
 *
 * Resolved once and cached: the CLI call costs a second or two, and every
 * worker process would otherwise pay it repeatedly.
 */
export interface SupabaseEnvironment {
  apiUrl: string;
  databaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  /**
   * The local mail catcher, where every email the stack sends arrives.
   *
   * Needed by the confirmation-flow spec, which reads a real email rather than
   * composing the link it is supposed to be testing. Defaults to the CLI's
   * standard port so a stack started without the extra environment variable
   * still works.
   */
  mailpitUrl: string;
}

interface SupabaseStatusJson {
  API_URL?: string;
  DB_URL?: string;
  ANON_KEY?: string;
  SERVICE_ROLE_KEY?: string;
  MAILPIT_URL?: string;
  INBUCKET_URL?: string;
}

const DEFAULT_MAILPIT_URL = 'http://127.0.0.1:54324';

let cached: SupabaseEnvironment | null = null;

export function readSupabaseEnvironment(): SupabaseEnvironment {
  if (cached !== null) {
    return cached;
  }

  // The environment wins when set, which is how CI passes values it already
  // captured and how a developer points the suite at a non-default port.
  const fromEnv = {
    apiUrl: process.env['E2E_SUPABASE_URL'],
    databaseUrl: process.env['E2E_DATABASE_URL'],
    anonKey: process.env['E2E_SUPABASE_ANON_KEY'],
    serviceRoleKey: process.env['E2E_SUPABASE_SERVICE_ROLE_KEY'],
  };

  if (
    fromEnv.apiUrl !== undefined &&
    fromEnv.databaseUrl !== undefined &&
    fromEnv.anonKey !== undefined &&
    fromEnv.serviceRoleKey !== undefined
  ) {
    cached = {
      apiUrl: fromEnv.apiUrl,
      databaseUrl: fromEnv.databaseUrl,
      anonKey: fromEnv.anonKey,
      serviceRoleKey: fromEnv.serviceRoleKey,
      mailpitUrl: process.env['E2E_MAILPIT_URL'] ?? DEFAULT_MAILPIT_URL,
    };
    return cached;
  }

  let raw: string;
  try {
    raw = execFileSync('npx', ['supabase', 'status', '-o', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(
      'Could not read the local Supabase status. Run `npx supabase start` before the E2E suite.',
    );
  }

  // The CLI prints deprecation warnings on stderr and sometimes a banner line
  // before the JSON, so take the object rather than the whole stream.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('Unexpected output from `supabase status -o json`.');
  }

  const status = JSON.parse(raw.slice(start, end + 1)) as SupabaseStatusJson;

  if (
    status.API_URL === undefined ||
    status.DB_URL === undefined ||
    status.ANON_KEY === undefined ||
    status.SERVICE_ROLE_KEY === undefined
  ) {
    throw new Error('`supabase status` did not report the API, database and keys.');
  }

  cached = {
    apiUrl: status.API_URL,
    databaseUrl: status.DB_URL,
    anonKey: status.ANON_KEY,
    serviceRoleKey: status.SERVICE_ROLE_KEY,
    mailpitUrl:
      process.env['E2E_MAILPIT_URL'] ??
      status.MAILPIT_URL ??
      status.INBUCKET_URL ??
      DEFAULT_MAILPIT_URL,
  };
  return cached;
}

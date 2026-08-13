import { NextResponse } from 'next/server';
import { createSupabaseAnonClient } from '@/lib/supabase/anon';

/**
 * Liveness and readiness for whatever is watching the deployment.
 *
 * WHAT IT DELIBERATELY DOES NOT REPORT. No version, no commit, no environment
 * name, no table counts, no league names, no error text from a failed probe.
 * This endpoint is unauthenticated — anything it returns is public — and a
 * health check is a favourite reconnaissance target precisely because it is the
 * one route people forget to think about. It answers "is this deployment
 * serving traffic and can it reach its database", and nothing else.
 *
 * The probe is a real query rather than a connection test, because a pool that
 * connects but cannot read is exactly the failure a health check exists to
 * catch.
 *
 * IT MUST READ `searchable_leagues_public`, NOT `leagues`.
 *
 * `anon` holds no grant of any kind on `leagues` — only `authenticated` does —
 * so an anonymous `select` against the base table is refused by PostgREST with
 * a 401 before Row Level Security is ever consulted. The public projection is
 * the one object anonymous discovery is deliberately allowed to read, and it is
 * therefore the only correct probe for a client that has no session.
 *
 * This is not a theoretical distinction: the route originally probed `leagues`
 * and every production health check returned
 * `{"status":"degraded","database":"unreachable"}` while the database was
 * entirely healthy. It passed locally only because nothing exercised it.
 *
 * The projection is also the safer target on its own merits. It exposes seven
 * columns of already-public information and filters to `visibility =
 * 'searchable'`, so this probe cannot become a data leak even if the query grew
 * — whereas `leagues` carries private locations and settings.
 *
 * `head: true` means no rows cross the wire; the request succeeds or it does
 * not.
 */
export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 5_000;

export async function GET(): Promise<NextResponse> {
  let database: 'ok' | 'unreachable' = 'unreachable';

  try {
    const supabase = createSupabaseAnonClient();

    // Bounded explicitly. Without this the route inherits the platform's
    // function timeout, and a health check that hangs for 300 seconds is worse
    // than one that fails in five: the watchdog cannot tell "slow" from "gone".
    const probe = supabase
      .from('searchable_leagues_public')
      .select('id', { count: 'exact', head: true });
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error('timeout'));
      }, TIMEOUT_MS);
    });

    const { error } = await Promise.race([probe, timeout]);
    database = error === null ? 'ok' : 'unreachable';
  } catch {
    // Swallowed on purpose: the status code carries the outcome, and the
    // exception text could name a host, a role or a constraint.
    database = 'unreachable';
  }

  const healthy = database === 'ok';

  return NextResponse.json(
    { status: healthy ? 'ok' : 'degraded', database },
    {
      status: healthy ? 200 : 503,
      // Never cached. A cached health check reports the state of whichever
      // instance answered first, for as long as the cache lives.
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    },
  );
}

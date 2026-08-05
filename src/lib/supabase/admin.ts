import 'server-only';

import { createClient } from '@supabase/supabase-js';
import { getPublicEnv } from '@/lib/env';
import type { Database } from '@/types/database';

/**
 * Service-role Supabase client. **Bypasses Row Level Security entirely.**
 *
 * Three separate guards keep it off the client:
 *   1. `import 'server-only'` — the build fails if a Client Component imports
 *      this module, directly or transitively;
 *   2. the ESLint rule in eslint.config.mjs, which blocks the import path
 *      outside server directories;
 *   3. the runtime check below, as a last resort.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` has no `NEXT_PUBLIC_` prefix, so Next.js will not
 * inline it into a browser bundle even if something else goes wrong.
 *
 * Use only after performing an explicit authorization check. Phase 1 needs it
 * for nothing; it exists so later phases have one reviewed way to reach it.
 */
/**
 * Whether a service-role key is configured.
 *
 * Exists so that callers which merely need to *know* — the push dispatcher
 * degrades to in-app-only without one — never have to name the environment
 * variable themselves. Keeping the name in exactly one module is what makes
 * `tests/unit/secret-hygiene.test.ts` able to assert where it may appear.
 */
export function isServiceRoleConfigured(): boolean {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return key !== undefined && key.trim() !== '';
}

export function createSupabaseAdminClient() {
  if (typeof window !== 'undefined') {
    throw new Error('The Supabase service-role client must never run in the browser.');
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (serviceRoleKey === undefined || serviceRoleKey.trim() === '') {
    throw new Error(
      'Missing environment variable SUPABASE_SERVICE_ROLE_KEY. It is server-only and must never be exposed to the browser.',
    );
  }

  const { supabaseUrl } = getPublicEnv();

  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      // A service-role client has no user session and must never persist or
      // refresh one.
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

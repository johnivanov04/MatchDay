import 'server-only';

import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { getPublicEnv } from '@/lib/env';
import type { Database } from '@/types/database';

/**
 * Server-side Supabase client bound to the request's session cookies.
 *
 * It uses the anon key, not the service-role key, so everything it reads and
 * writes still passes through Row Level Security. Server-side authorization
 * checks sit on top of that, giving the two independent layers PRD §12
 * requires.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const { supabaseUrl, supabaseAnonKey } = getPublicEnv();

  return createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies. Session refresh happens in
          // src/proxy.ts, which runs before rendering, so ignoring this is
          // safe rather than merely convenient.
        }
      },
    },
  });
}

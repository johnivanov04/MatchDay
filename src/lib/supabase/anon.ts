import 'server-only';

import { createClient } from '@supabase/supabase-js';
import { getPublicEnv } from '@/lib/env';
import type { Database } from '@/types/database';

/**
 * A Supabase client with no session at all.
 *
 * Distinct from `createSupabaseServerClient`, which binds to the request's
 * cookies and is what almost everything should use. This one is for the health
 * check, which has no user, must not read cookies, and must not be able to see
 * anything a signed-out visitor could not — it is the anonymous key, so Row
 * Level Security applies exactly as it does to a logged-out browser.
 *
 * It is emphatically not the service-role client. Nothing here bypasses a
 * policy.
 */
export function createSupabaseAnonClient() {
  const { supabaseUrl, supabaseAnonKey } = getPublicEnv();

  return createClient<Database>(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

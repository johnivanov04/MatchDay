'use client';

import { createBrowserClient } from '@supabase/ssr';
import { getPublicEnv } from '@/lib/env';
import type { Database } from '@/types/database';

/**
 * Browser Supabase client. Carries the anon key and the user's own session, so
 * every request it makes is subject to Row Level Security.
 */
export function createSupabaseBrowserClient() {
  const { supabaseUrl, supabaseAnonKey } = getPublicEnv();
  return createBrowserClient<Database>(supabaseUrl, supabaseAnonKey);
}

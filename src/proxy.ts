import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { getPublicEnv } from '@/lib/env';
import type { Database } from '@/types/database';

/**
 * Next.js Proxy (the Next 16 successor to Middleware).
 *
 * Its only job is to refresh the Supabase session cookie before a request
 * reaches a Server Component, since Server Components cannot write cookies.
 *
 * It deliberately performs **no authorization**. Route protection lives in the
 * authenticated layout and in Row Level Security, both of which run for every
 * request regardless of matcher configuration. Treating a proxy matcher as an
 * access-control boundary is a well-known way to ship an auth bypass.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const { supabaseUrl, supabaseAnonKey } = getPublicEnv();

  const supabase = createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Revalidates the token with the auth server and rotates the cookie when
  // needed. The result is intentionally unused here.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image files. Sign-in pages are
     * included on purpose: a visitor arriving with an expired cookie should
     * have it cleaned up before rendering.
     *
     * `.well-known` is excluded so Apple's App Site Association fetch does not
     * trigger a Supabase session lookup. That fetch carries no cookies and has
     * nothing to refresh, and Apple's CDN is strict about how this document is
     * served — there is no reason to put a network round trip in front of a
     * static file it polls on its own schedule.
     */
    '/((?!_next/static|_next/image|favicon.ico|\\.well-known|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};

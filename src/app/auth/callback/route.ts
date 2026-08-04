import { NextResponse, type NextRequest } from 'next/server';
import { safeRedirectPath } from '@/lib/auth/safe-redirect';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Magic-link landing route: exchanges the one-time code in the URL for a
 * session cookie, then sends the user on.
 *
 * The destination is sanitised by `safeRedirectPath` because the `next`
 * parameter travels in a link an attacker can compose.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const next = safeRedirectPath(searchParams.get('next'));

  if (code === null) {
    return NextResponse.redirect(`${origin}/sign-in?error=missing_code`);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error !== null) {
    // An expired link and a forged one are reported identically.
    return NextResponse.redirect(`${origin}/sign-in?error=invalid_link`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}

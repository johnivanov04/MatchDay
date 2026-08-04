import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Sign-out is POST-only. A GET endpoint that destroys a session can be
 * triggered by any third-party page embedding it as an image, which is a
 * nuisance rather than a breach — but there is no reason to allow it.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  return NextResponse.redirect(`${request.nextUrl.origin}/sign-in`, { status: 303 });
}

import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Sign-out is POST-only. A GET endpoint that destroys a session can be
 * triggered by any third-party page embedding it as an image, which is a
 * nuisance rather than a breach — but there is no reason to allow it.
 *
 * ── WHY THE APNs CLEANUP LIVES HERE ────────────────────────────────────────
 *
 * A phone that has been signed out must stop receiving that account's
 * notifications, and the only moment that can be guaranteed is this one. Doing
 * it in a component before submitting would mean a sign-out reached by any
 * other route — a second button, a redirect, a form posted with JavaScript
 * disabled — silently leaves the device subscribed, and the next person to use
 * that phone starts receiving somebody else's match alerts.
 *
 * The device is named by its installation id, appended to the form by the
 * native shell. That identifier is the one thing the app reliably knows about
 * itself at this moment: the current APNs token may have been rotated while the
 * app was closed, and asking Apple for a fresh one here is neither instant nor
 * guaranteed to succeed.
 *
 * Nothing about this can fail a sign-out. The order matters — the removal needs
 * the session that `signOut` is about to destroy — but its outcome does not.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createSupabaseServerClient();

  try {
    const formData = await request.formData();
    const installationId = formData.get('installation_id');

    // Validated to the column's own shape before being sent. The function
    // scopes its delete to the caller, so a wrong value removes nothing — this
    // just avoids a pointless round trip.
    if (typeof installationId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(installationId)) {
      await supabase.rpc('remove_apns_installation', { p_installation_id: installationId });
    }
  } catch {
    // A sign-out with no body, an unreadable one, or a failed removal. The
    // device keeps its subscription until it re-registers under a new owner or
    // the dispatcher retires it; none of that is worth refusing to sign
    // somebody out for.
  }

  await supabase.auth.signOut();

  return NextResponse.redirect(`${request.nextUrl.origin}/sign-in`, { status: 303 });
}

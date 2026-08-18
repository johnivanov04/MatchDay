'use server';

import { redirect } from 'next/navigation';
import { parseConfirmationParams } from '@/lib/auth/email-confirmation';
import { ONBOARDING_PATH } from '@/lib/auth/page-guards';
import { safeRedirectPath } from '@/lib/auth/safe-redirect';
import { getCurrentProfile } from '@/lib/auth/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Spending the one-time token — the only thing in the product that may.
 *
 * ── WHY THIS IS A POST AND NOT A PAGE ──────────────────────────────────────
 *
 * A confirmation token is single-use, and plenty of things open a link before
 * its recipient does: Brevo rewrites every link through its click tracker,
 * corporate mail scanners fetch links to inspect them, and some clients
 * prefetch for previews. Any GET that verified the token would be spent by the
 * first of those to arrive, and the person would be told their brand-new link
 * was invalid.
 *
 * So `/auth/continue` renders and does nothing, and this action — reachable
 * only by submitting its form — is what verifies. A scanner does not POST.
 *
 * ── WHY THIS FIXES THE CROSS-BROWSER FAILURE ───────────────────────────────
 *
 * `verifyOtp({ token_hash, type })` needs no PKCE code verifier, so it does not
 * care which browser asked for the email. The old path did: it bounced through
 * Supabase to `/auth/callback?code=…`, and `exchangeCodeForSession` reads a
 * verifier cookie that only exists in the originating browser. Opening the
 * email on a phone therefore always failed.
 *
 * The SSR client writes the session cookies itself, through the same cookie
 * adapter every other server-side Supabase call uses. No service role, no
 * manual cookie construction, no second code path.
 *
 * ── WHAT IS NEVER LOGGED ───────────────────────────────────────────────────
 *
 * The token hash is a live credential until it is spent. It is never logged,
 * never placed in an observability event, never echoed into a redirect, and
 * never rendered. Failures carry a reason code and nothing else — and the same
 * reason code for every cause, so this cannot be used to distinguish an expired
 * token from a forged one.
 */
export async function confirmEmailAction(formData: FormData): Promise<void> {
  const parsed = parseConfirmationParams(
    typeof formData.get('token_hash') === 'string' ? String(formData.get('token_hash')) : undefined,
    typeof formData.get('type') === 'string' ? String(formData.get('type')) : undefined,
  );

  // A tampered form field lands here rather than at Supabase.
  if (!parsed.ok) {
    redirect('/auth/continue?error=invalid');
  }

  // Sanitised at both hops: once when the link is rendered, and again here,
  // because a form field is as attacker-controllable as a query parameter.
  const next = safeRedirectPath(
    typeof formData.get('next') === 'string' ? String(formData.get('next')) : null,
  );

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({
    token_hash: parsed.tokenHash,
    type: parsed.type,
  });

  // Expired, already spent, forged, or the wrong type for this token: one
  // answer for all of them. Supabase's own message is not surfaced — it is an
  // internal detail, and the difference between "expired" and "never existed"
  // is not something an anonymous caller is entitled to learn.
  if (error !== null) {
    redirect('/auth/continue?error=invalid');
  }

  // Where they were going. A brand-new account has no profile row yet, and the
  // authenticated layout would bounce them to onboarding on arrival anyway —
  // sending them straight there saves a redirect and a flash of a page they
  // cannot use. This mirrors `requireOnboardedUser`, which remains the actual
  // enforcement.
  const profile = await getCurrentProfile();

  redirect(profile === null ? ONBOARDING_PATH : next);
}

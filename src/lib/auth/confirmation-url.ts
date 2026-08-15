import { getPublicEnv } from '@/lib/env';

/**
 * Validates the Supabase confirmation URL carried by a sign-in email.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Supabase's one-time confirmation links are consumed by whoever opens them
 * first — and that is very often not the human. Email link tracking (Brevo
 * rewrites every link through a `sendibt2.com` redirect), corporate security
 * scanners and inbox previewers all prefetch links, which burns the token
 * before the recipient touches it. The user then sees "invalid or expired
 * link" on a link they never used.
 *
 * Supabase's documented mitigation is a second click: the email points at a
 * page on our own origin, and only a deliberate human click follows the real
 * confirmation URL. `/auth/continue` is that page, and this module decides
 * whether the URL it was handed is one we are willing to send anybody to.
 *
 * ── WHY VALIDATION IS NOT OPTIONAL ─────────────────────────────────────────
 *
 * `confirmation_url` arrives as a query parameter, so anybody can compose a
 * link to `/auth/continue?confirmation_url=https://evil.example`. Rendering
 * that unchecked would turn a page users are told to trust — reached from a
 * genuine-looking sign-in email, on our real domain — into an open redirect
 * and a ready-made phishing hop. This is the same threat `safeRedirectPath`
 * exists for, one hop earlier in the chain.
 *
 * ── WHAT A REAL CONFIRMATION URL LOOKS LIKE ────────────────────────────────
 *
 * Verified by generating one against a live Supabase instance rather than
 * assuming:
 *
 *   {SUPABASE_URL}/auth/v1/verify?token=<hash>&type=magiclink&redirect_to=<app>
 *
 * So the origin is the configured Supabase project and the path is fixed.
 */

/** The only path a Supabase email confirmation link ever points at. */
export const SUPABASE_VERIFY_PATH = '/auth/v1/verify';

export type ConfirmationUrlRejection =
  | 'missing'
  | 'unparseable'
  | 'insecure_protocol'
  | 'wrong_origin'
  | 'wrong_path';

export type ConfirmationUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: ConfirmationUrlRejection };

/**
 * Accepts only a URL that could genuinely have come from our own Supabase
 * project's email.
 *
 * THE ORIGIN IS DERIVED, NOT HARDCODED. It comes from
 * `NEXT_PUBLIC_SUPABASE_URL`, the same value every Supabase client in the
 * application is built from, so this cannot drift from the project actually in
 * use and no project ref is baked into the source.
 *
 * That also settles the protocol question without a special case: production
 * is configured with an `https:` URL, so an `http:` confirmation link fails the
 * origin comparison there, while a local stack configured as
 * `http://127.0.0.1:54321` keeps working. The explicit protocol check below is
 * a second, narrower guard — it refuses anything that is not http/https at all,
 * so a `javascript:` or `data:` value cannot reach an `href`.
 */
export function validateConfirmationUrl(raw: string | null | undefined): ConfirmationUrlResult {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: 'missing' };
  }

  let candidate: URL;
  let expected: URL;
  try {
    candidate = new URL(raw);
    expected = new URL(getPublicEnv().supabaseUrl);
  } catch {
    // Covers both a malformed parameter and a misconfigured deployment. Either
    // way there is nothing safe to link to.
    return { ok: false, reason: 'unparseable' };
  }

  // `javascript:`, `data:` and friends never reach an href. Checked before the
  // origin comparison because a non-hierarchical scheme has an origin of
  // "null", which would otherwise fail with a less accurate reason.
  if (candidate.protocol !== 'https:' && candidate.protocol !== 'http:') {
    return { ok: false, reason: 'insecure_protocol' };
  }

  // Production's configured URL is https, so this rejects http there. A local
  // http stack still matches itself.
  if (candidate.protocol !== expected.protocol) {
    return { ok: false, reason: 'insecure_protocol' };
  }

  // `origin` compares scheme, host and port together, so neither a lookalike
  // host nor a different port slips through.
  if (candidate.origin !== expected.origin) {
    return { ok: false, reason: 'wrong_origin' };
  }

  // Exact match. A prefix test would accept `/auth/v1/verify/../../something`
  // — though `new URL` normalises that away, an exact comparison does not
  // depend on knowing so.
  if (candidate.pathname !== SUPABASE_VERIFY_PATH) {
    return { ok: false, reason: 'wrong_path' };
  }

  // `candidate.toString()` rather than the raw input: the parsed, normalised
  // form is what was actually validated, so it is what should be rendered.
  return { ok: true, url: candidate.toString() };
}

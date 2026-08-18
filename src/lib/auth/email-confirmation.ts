/**
 * The parameters a MatchDay confirmation email carries, and what we accept.
 *
 * ── WHY THIS REPLACES THE NESTED CONFIRMATION URL ──────────────────────────
 *
 * The old email pointed at `/auth/continue?confirmation_url=<supabase verify
 * url>`, and pressing the button navigated to Supabase, which verified the
 * token and redirected back to `/auth/callback?code=…`. That last hop is PKCE:
 * `exchangeCodeForSession` needs the code verifier cookie, and the verifier
 * only exists in the browser that *requested* the email.
 *
 * Open the email in Gmail's in-app browser, on a second device, or after
 * clearing cookies, and there is no verifier — so the exchange fails and the
 * person lands back on the sign-in page holding a link they never used. The
 * SDK says so in as many words: "PKCE code verifier not found in storage. This
 * can happen if the auth flow was initiated in a different browser or device."
 *
 * The token-hash flow has no verifier and therefore no such coupling. The email
 * carries the hashed token itself, our own POST verifies it with `verifyOtp`,
 * and the session cookie is written by whichever browser the person actually
 * used. Verified against @supabase/auth-js 2.112.0 on a real stack: a fresh
 * browser with no prior state authenticates, and a replay is refused.
 *
 * ── WHY THE SHAPE IS CHECKED AT ALL ────────────────────────────────────────
 *
 * `token_hash` and `type` arrive as query parameters, so anybody can compose a
 * link to this page. Nothing here decides whether a token is *valid* — only
 * Supabase can — but rejecting the obviously malformed keeps junk out of the
 * verification call, and keeps `type` on a leash: an allowlist is what stops a
 * crafted link driving a flow this stage has not built yet.
 */

/**
 * The only confirmation types MatchDay sends today.
 *
 * `signup` is a brand-new account confirming its address; `magiclink` is an
 * existing account signing in. Both come from `signInWithOtp`, which chooses
 * between them by whether the address already exists — verified against the
 * local stack rather than assumed.
 *
 * `recovery`, `invite` and `email_change` are deliberately absent. Password
 * recovery is a later stage, and a type this application does not send is a
 * type a crafted link must not be able to drive.
 */
export const CONFIRMATION_TYPES = ['signup', 'magiclink'] as const;

export type ConfirmationType = (typeof CONFIRMATION_TYPES)[number];

export type ConfirmationRejection =
  | 'missing_token'
  | 'malformed_token'
  | 'missing_type'
  | 'unsupported_type';

export type ConfirmationParams =
  | { ok: true; tokenHash: string; type: ConfirmationType }
  | { ok: false; reason: ConfirmationRejection };

/**
 * What a real token hash looks like.
 *
 * Observed from a live stack: `pkce_` followed by 56 hex characters when the
 * email was triggered by a PKCE client, which every `@supabase/ssr` client is.
 * A plain hash is emitted otherwise.
 *
 * The pattern below is deliberately looser than either. Pinning it to today's
 * exact length or prefix would turn a GoTrue implementation detail into a
 * MatchDay outage the day it changed, and this check is not what makes a token
 * trustworthy — Supabase is. What it does is keep control characters, path
 * traversal and megabyte-long junk out of an outbound API call.
 */
const TOKEN_HASH_PATTERN = /^[A-Za-z0-9_-]{20,256}$/;

function isConfirmationType(value: string): value is ConfirmationType {
  return (CONFIRMATION_TYPES as readonly string[]).includes(value);
}

/**
 * Reads the confirmation parameters from a URL's query.
 *
 * Never throws and never echoes the token back in a rejection: every failure
 * reports a reason code and nothing else, so this cannot be used to probe what
 * we accept.
 */
export function parseConfirmationParams(
  rawToken: string | string[] | undefined,
  rawType: string | string[] | undefined,
): ConfirmationParams {
  if (typeof rawToken !== 'string' || rawToken === '') {
    return { ok: false, reason: 'missing_token' };
  }
  if (!TOKEN_HASH_PATTERN.test(rawToken)) {
    return { ok: false, reason: 'malformed_token' };
  }
  if (typeof rawType !== 'string' || rawType === '') {
    return { ok: false, reason: 'missing_type' };
  }
  if (!isConfirmationType(rawType)) {
    return { ok: false, reason: 'unsupported_type' };
  }

  return { ok: true, tokenHash: rawToken, type: rawType };
}

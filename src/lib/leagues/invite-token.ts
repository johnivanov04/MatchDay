import { randomBytes } from 'node:crypto';

/**
 * Invitation-token generation.
 *
 * Design, and why each part matters:
 *
 * - **Unguessable.** 32 bytes from the platform CSPRNG — 256 bits. Not
 *   `Math.random`, not a UUID (a v4 UUID carries 122 bits and a recognisable
 *   shape), and not derived from the league id, which would make one link
 *   predict another.
 * - **Never stored.** The raw token is handed to the creating administrator
 *   once and then forgotten by the server. Only `sha256(token)` reaches the
 *   database, computed *inside* `create_league_invite()`. Because the stored
 *   value is a one-way digest, reading `league_invites` — even with full table
 *   access — yields nothing redeemable.
 * - **URL-safe.** base64url, so the token survives being pasted into a chat
 *   message or an address bar without escaping.
 *
 * Expiry, revocation and usage limits live on the database row; see
 * `supabase/migrations/20260803020000_join_requests_and_invites.sql`.
 */

const TOKEN_BYTES = 32;

/** base64url of 32 random bytes: 43 characters, 256 bits of entropy. */
export function generateInviteToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Cheap shape check before a token is sent to the database.
 *
 * This is not authentication — `redeem_league_invite()` decides that by digest
 * comparison. It exists so an obviously malformed path segment is rejected
 * without a round trip, and so an attacker cannot use very long inputs to make
 * the server do pointless work.
 */
export function isPlausibleInviteToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

/** The shareable link for a token. Built from configuration, not from a request header. */
export function buildInviteUrl(siteUrl: string, token: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/invite/${token}`;
}

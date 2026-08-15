/**
 * The email one-time code, and how long it is allowed to be.
 *
 * ── WHY THIS MODULE EXISTS ─────────────────────────────────────────────────
 *
 * MatchDay hard-coded six digits in two independent places — the input's
 * `maxLength` and the server's `/^\d{6}$/` — and production Supabase is
 * configured to send **eight**. The browser physically refused to accept the
 * seventh and eighth characters, so the code could not be entered at all, and
 * even a pasted one would have been rejected by the schema. Supabase supports
 * 6 to 10 inclusive, so the client must too.
 *
 * The bounds live here, in a module with no dependencies, so the input and the
 * validator cannot drift apart again. Importing them costs the client bundle
 * nothing — there is no Zod here, and the schema that uses these constants is
 * built server-side.
 *
 * ── ALWAYS A STRING ────────────────────────────────────────────────────────
 *
 * A one-time code is an opaque identifier that happens to be spelled with
 * digits, not a number. `Number('006391')` is `6391`, which would silently
 * destroy a leading-zero code — and one code in ten begins with a zero. Nothing
 * in this flow may parse it, and `normalizeEmailOtp` returns a string for that
 * reason.
 */

/** Supabase's minimum configurable email OTP length. */
export const EMAIL_OTP_MIN_LENGTH = 6;

/** Supabase's maximum configurable email OTP length. */
export const EMAIL_OTP_MAX_LENGTH = 10;

/**
 * Strips the whitespace people paste along with a code from their mail client.
 *
 * Whitespace only. It deliberately does not strip other characters: a code
 * arriving with letters in it means something is wrong, and quietly discarding
 * them would turn a clear "that code is not valid" into a confusing failure at
 * Supabase instead.
 */
export function normalizeEmailOtp(raw: string): string {
  return raw.replaceAll(/\s/g, '');
}

/**
 * True for a plausible email OTP: digits only, 6 to 10 of them.
 *
 * Deliberately not a length-specific check. Supabase's configured length can be
 * changed in the dashboard at any time, and a client that hard-codes today's
 * value breaks the moment somebody does — which is exactly the bug this
 * replaces.
 */
export function isValidEmailOtp(value: string): boolean {
  return new RegExp(`^\\d{${EMAIL_OTP_MIN_LENGTH},${EMAIL_OTP_MAX_LENGTH}}$`).test(value);
}

/** The `pattern` attribute for the input, kept in step with the validator. */
export const EMAIL_OTP_INPUT_PATTERN = `[0-9]{${EMAIL_OTP_MIN_LENGTH},${EMAIL_OTP_MAX_LENGTH}}`;

/**
 * What the person is told when their code will not do.
 *
 * One message for too short, too long and non-numeric. Naming a specific length
 * would be wrong the next time the Supabase setting changes, and the person
 * copying a code out of an email does not need a specification — they need to
 * know it did not work.
 */
export const EMAIL_OTP_ERROR_MESSAGE = 'Enter the one-time code from your email.';

import { z } from 'zod';

/**
 * Password rules.
 *
 * ── LENGTH, AND NOTHING ELSE ───────────────────────────────────────────────
 *
 * Ten characters, no composition requirement. Requiring an uppercase letter, a
 * digit and a symbol does not produce strong passwords — it produces
 * `Password1!` and a sticky note, and it rules out the passphrases that are
 * actually hard to guess. Length is the only rule that survives contact with
 * how people behave.
 *
 * Ten rather than Supabase's default six because six is two seconds of offline
 * guessing. `minimum_password_length` in `supabase/config.toml` is set to the
 * same number: Supabase is the authority, and this exists so somebody is told
 * before they submit rather than after.
 *
 * ── NEVER TRANSFORMED ──────────────────────────────────────────────────────
 *
 * Every other string in this codebase is trimmed. A password is not: leading
 * and trailing spaces are characters somebody deliberately typed, a password
 * manager may well have generated them, and silently removing them means the
 * password stored is not the one shown. That is a support ticket nobody can
 * diagnose.
 */

export const PASSWORD_MIN_LENGTH = 10;

/** Supabase refuses anything longer; bcrypt truncates at 72 bytes anyway. */
export const PASSWORD_MAX_LENGTH = 72;

/** Shown before submission, so the rule is never a surprise. */
export const PASSWORD_REQUIREMENT_TEXT = `At least ${String(PASSWORD_MIN_LENGTH)} characters. Longer is better — a short sentence works well.`;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, {
    message: `Use at least ${String(PASSWORD_MIN_LENGTH)} characters.`,
  })
  .max(PASSWORD_MAX_LENGTH, {
    message: `Use ${String(PASSWORD_MAX_LENGTH)} characters or fewer.`,
  });

/**
 * A new password and its confirmation.
 *
 * The mismatch is reported on the *confirmation* field, because that is the one
 * the person is being asked to correct.
 */
export const newPasswordSchema = z
  .object({
    password: passwordSchema,
    confirm_password: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.password !== value.confirm_password) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirm_password'],
        message: 'Both passwords must match.',
      });
    }
  });

export const emailSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.email({ message: 'Enter a valid email address.' }));

/**
 * Sign-in credentials.
 *
 * The password is only checked for presence here. Applying the length rule to a
 * *login* would tell somebody with an older, shorter password that their
 * password is wrong for a reason that has nothing to do with whether it is
 * correct — and would quietly reveal the rule to anybody probing.
 */
export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, { message: 'Enter your password.' }),
});

export const signUpSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    confirm_password: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.password !== value.confirm_password) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirm_password'],
        message: 'Both passwords must match.',
      });
    }
  });

/**
 * The one message every failed sign-in gets.
 *
 * Supabase already answers "wrong password" and "no such account" identically
 * — both are `Invalid login credentials`, status 400, verified against the
 * installed SDK. This exists so MatchDay does not reintroduce the distinction
 * on top of an API that carefully avoids it.
 */
export const SIGN_IN_FAILURE_MESSAGE = 'Email or password is incorrect.';

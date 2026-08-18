import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  newPasswordSchema,
  passwordSchema,
  signInSchema,
  signUpSchema,
  SIGN_IN_FAILURE_MESSAGE,
} from '@/lib/validation/password';

/**
 * Password rules, and the things about them that are easy to get wrong.
 */

describe('the length rule', () => {
  it('is ten characters', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10);
  });

  it('accepts exactly ten', () => {
    expect(passwordSchema.safeParse('a'.repeat(10)).success).toBe(true);
  });

  it('refuses nine', () => {
    const result = passwordSchema.safeParse('a'.repeat(9));

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('10');
  });

  it('refuses more than bcrypt can hash', () => {
    expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(false);
  });

  it('imposes no composition requirement', () => {
    // A passphrase with no digits, symbols or capitals is a good password and
    // must not be refused for looking plain.
    expect(passwordSchema.safeParse('correct horse battery staple').success).toBe(true);
  });
});

describe('a password is never transformed', () => {
  it('keeps leading and trailing spaces', () => {
    // Trimming would store a different password from the one that was shown,
    // which is a support ticket nobody can diagnose. A manager may well have
    // generated those spaces.
    const withSpaces = '  spaces matter  ';
    const result = passwordSchema.safeParse(withSpaces);

    expect(result.success).toBe(true);
    expect(result.data).toBe(withSpaces);
  });

  it('keeps unicode intact', () => {
    const emoji = 'passphrase-⚽-football';
    expect(passwordSchema.safeParse(emoji).data).toBe(emoji);
  });

  it('counts a short password made of spaces as short', () => {
    expect(passwordSchema.safeParse('   ').success).toBe(false);
  });
});

describe('confirmation matching', () => {
  it('accepts a matching pair', () => {
    const result = newPasswordSchema.safeParse({
      password: 'correct horse battery',
      confirm_password: 'correct horse battery',
    });
    expect(result.success).toBe(true);
  });

  it('reports a mismatch on the confirmation field, which is the one to fix', () => {
    const result = newPasswordSchema.safeParse({
      password: 'correct horse battery',
      confirm_password: 'correct horse bettery',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['confirm_password']);
  });

  it('treats a trailing space as a mismatch rather than quietly matching', () => {
    const result = newPasswordSchema.safeParse({
      password: 'correct horse battery',
      confirm_password: 'correct horse battery ',
    });
    expect(result.success).toBe(false);
  });
});

describe('signing up', () => {
  it('lower-cases and trims the email but not the password', () => {
    const result = signUpSchema.safeParse({
      email: '  Player@MatchDay.TEST ',
      password: ' a-long-enough-password ',
      confirm_password: ' a-long-enough-password ',
    });

    expect(result.success).toBe(true);
    expect(result.data?.email).toBe('player@matchday.test');
    expect(result.data?.password).toBe(' a-long-enough-password ');
  });

  it('refuses a short password before it reaches Supabase', () => {
    const result = signUpSchema.safeParse({
      email: 'player@matchday.test',
      password: 'short',
      confirm_password: 'short',
    });
    expect(result.success).toBe(false);
  });
});

describe('signing in', () => {
  it('does not apply the length rule to an existing password', () => {
    // Applying it would tell somebody with an older, shorter password that it
    // is wrong for a reason unrelated to whether it is correct — and would
    // quietly reveal the rule to anybody probing.
    const result = signInSchema.safeParse({ email: 'a@b.test', password: 'six' });
    expect(result.success).toBe(true);
  });

  it('still requires something to be typed', () => {
    expect(signInSchema.safeParse({ email: 'a@b.test', password: '' }).success).toBe(false);
  });

  it('has one failure message that names neither field', () => {
    expect(SIGN_IN_FAILURE_MESSAGE).toBe('Email or password is incorrect.');
    expect(SIGN_IN_FAILURE_MESSAGE.toLowerCase()).not.toContain('account');
    expect(SIGN_IN_FAILURE_MESSAGE.toLowerCase()).not.toContain('exist');
  });
});

/** A file's source with comments removed, so prose cannot satisfy a code scan. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the auth actions keep credentials to themselves', () => {
  const code = codeOf('src/server/actions/auth-password.ts');

  it('logs nothing at all', () => {
    expect(code).not.toContain('console.');
    expect(code).not.toContain('logEvent');
    expect(code).not.toContain('observability');
  });

  it('never interpolates a password or a token into a redirect', () => {
    expect(code).not.toMatch(/redirect\([^)]*password/i);
    expect(code).not.toMatch(/redirect\([^)]*token/i);
  });

  it('never surfaces Supabase’s own error text', () => {
    // `Invalid login credentials`, `User already registered` and `Email not
    // confirmed` are all internal details — the last two are enumeration
    // oracles if repeated to the caller.
    expect(code).not.toContain('error.message');
    expect(code).not.toContain('reauth.message');
  });

  it('uses the ordinary SSR client and never the service role', () => {
    expect(code).toContain('createSupabaseServerClient');
    expect(code).not.toContain('createSupabaseAdminClient');
    expect(code).not.toContain('SERVICE_ROLE');
  });

  it('never reads auth.users directly', () => {
    // Determining whether a password exists by inspecting `encrypted_password`
    // would need the service role and would be a privileged oracle built for a
    // cosmetic decision.
    expect(code).not.toContain('encrypted_password');
    expect(code).not.toContain("from('auth");
    expect(code).not.toContain('auth.users');
  });

  it('sanitises every destination', () => {
    expect(code).toContain('safeRedirectPath');
  });

  it('signs the code flow out of creating users', () => {
    const otp = codeOf('src/server/actions/auth.ts');
    expect(otp).toContain('shouldCreateUser: false');
    expect(otp).not.toContain('shouldCreateUser: true');
  });
});

describe('the password field markup', () => {
  const code = codeOf('src/components/ui/password-field.tsx');

  it('never sets a maxLength that could truncate a generated secret', () => {
    expect(code).not.toContain('maxLength');
  });

  it('offers the visibility state to assistive technology', () => {
    expect(code).toContain('aria-pressed');
  });

  it('keeps the toggle at the touch-target floor', () => {
    expect(code).toContain('min-h-control');
  });
});

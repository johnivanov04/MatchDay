import { describe, expect, it } from 'vitest';
import { signUpSchema } from '@/lib/validation/password';

/**
 * Agreeing to the rules before you can contribute content.
 *
 * The subtlety worth a test is the shape of the value. An unticked checkbox
 * posts NOTHING — not "false", not "off", not an empty string from the browser.
 * A schema that coerced the field to a boolean would read that absence as a
 * deliberate "no" and, depending on how it was written, let the form through
 * anyway. `literal('on')` has no such reading.
 */

const VALID = {
  email: 'player@example.test',
  password: 'correct horse battery staple',
  confirm_password: 'correct horse battery staple',
};

describe('sign-up requires accepting the terms', () => {
  it('accepts a signup with the box ticked', () => {
    const parsed = signUpSchema.safeParse({ ...VALID, accept_terms: 'on' });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['', 'the empty string the action substitutes when the field is absent'],
    ['off', 'a value no browser sends, but a crafted request might'],
    ['false', 'the same'],
    ['true', 'a truthy-looking value that is still not what a checkbox posts'],
  ])('refuses %j (%s)', (value) => {
    const parsed = signUpSchema.safeParse({ ...VALID, accept_terms: value });
    expect(parsed.success).toBe(false);
  });

  it('refuses a signup with the field missing entirely', () => {
    const parsed = signUpSchema.safeParse(VALID);
    expect(parsed.success).toBe(false);
  });

  it('names the field so the form can show the error beside the box', () => {
    const parsed = signUpSchema.safeParse({ ...VALID, accept_terms: '' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path[0] === 'accept_terms')).toBe(true);
    }
  });

  it('still enforces everything it enforced before', () => {
    const mismatched = signUpSchema.safeParse({
      ...VALID,
      confirm_password: 'something else',
      accept_terms: 'on',
    });
    expect(mismatched.success).toBe(false);
  });
});

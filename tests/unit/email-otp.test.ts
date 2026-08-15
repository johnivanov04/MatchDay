import { describe, expect, it } from 'vitest';
import {
  EMAIL_OTP_ERROR_MESSAGE,
  EMAIL_OTP_INPUT_PATTERN,
  EMAIL_OTP_MAX_LENGTH,
  EMAIL_OTP_MIN_LENGTH,
  isValidEmailOtp,
  normalizeEmailOtp,
} from '@/lib/auth/otp';

/**
 * The email one-time code's accepted shape.
 *
 * THE BUG THIS PREVENTS: MatchDay assumed six digits in two places while
 * production Supabase sends eight, so nobody could sign in with a code at all —
 * the input's `maxLength` refused the last two characters, and the server's
 * `/^\d{6}$/` would have rejected them anyway. Supabase's setting spans 6 to 10
 * and can be changed in the dashboard at any time, so nothing here may assume a
 * single length.
 */

describe('accepted lengths', () => {
  it('accepts a six-digit code, the Supabase minimum', () => {
    expect(isValidEmailOtp('123456')).toBe(true);
  });

  it('accepts an eight-digit code, which is what production sends', () => {
    // The exact case found on a physical iPhone during PWA testing.
    expect(isValidEmailOtp('12345678')).toBe(true);
  });

  it('accepts a ten-digit code, the Supabase maximum', () => {
    expect(isValidEmailOtp('1234567890')).toBe(true);
  });

  it('accepts every length in the supported range', () => {
    for (let length = EMAIL_OTP_MIN_LENGTH; length <= EMAIL_OTP_MAX_LENGTH; length += 1) {
      expect(isValidEmailOtp('1'.repeat(length)), `${String(length)} digits`).toBe(true);
    }
  });
});

describe('rejected input', () => {
  it('rejects fewer than six digits', () => {
    for (const value of ['', '1', '12345']) {
      expect(isValidEmailOtp(value), value).toBe(false);
    }
  });

  it('rejects more than ten digits', () => {
    for (const value of ['12345678901', '123456789012345']) {
      expect(isValidEmailOtp(value), value).toBe(false);
    }
  });

  it('rejects non-digits', () => {
    for (const value of [
      '12345a',
      'abcdef',
      '123 456',
      '123-456',
      '12345.6',
      '+1234567',
      '१२३४५६',
    ]) {
      expect(isValidEmailOtp(value), value).toBe(false);
    }
  });

  it('rejects a code with a decimal point that would parse as a number', () => {
    // Guards against anybody "simplifying" this to a numeric check.
    expect(isValidEmailOtp('123456.0')).toBe(false);
    expect(isValidEmailOtp('1e6')).toBe(false);
  });
});

describe('leading zeroes survive', () => {
  it('accepts a code that begins with zero', () => {
    expect(isValidEmailOtp('006391')).toBe(true);
    expect(isValidEmailOtp('00000000')).toBe(true);
  });

  it('normalization returns a string and keeps every leading zero', () => {
    const normalized = normalizeEmailOtp('006391');

    // `Number('006391')` is 6391 — a different code. Roughly one code in ten
    // starts with a zero, so this is not an edge case.
    expect(typeof normalized).toBe('string');
    expect(normalized).toBe('006391');
    expect(normalized).toHaveLength(6);
  });

  it('keeps an eight-digit leading-zero code intact', () => {
    expect(normalizeEmailOtp('00123456')).toBe('00123456');
    expect(isValidEmailOtp('00123456')).toBe(true);
  });
});

describe('normalization', () => {
  it('strips whitespace people paste from a mail client', () => {
    expect(normalizeEmailOtp('  1234 5678  ')).toBe('12345678');
    expect(normalizeEmailOtp('123\n456')).toBe('123456');
    expect(normalizeEmailOtp('12 34 56 78')).toBe('12345678');
  });

  it('does not truncate an eight-digit code', () => {
    // The original defect, stated directly.
    const production = '84726193';
    const normalized = normalizeEmailOtp(production);

    expect(normalized).toBe(production);
    expect(normalized).toHaveLength(8);
    expect(isValidEmailOtp(normalized)).toBe(true);
  });

  it('strips whitespace only, leaving anything else to fail validation', () => {
    // Silently discarding letters would turn "that code is not valid" into a
    // confusing failure at Supabase instead.
    expect(normalizeEmailOtp('12345a')).toBe('12345a');
    expect(isValidEmailOtp(normalizeEmailOtp('12345a'))).toBe(false);
  });
});

describe('the input attributes match the validator', () => {
  it('derives the pattern from the same bounds', () => {
    expect(EMAIL_OTP_INPUT_PATTERN).toBe('[0-9]{6,10}');
  });

  it('accepts in the browser exactly what the server accepts', () => {
    // A `pattern` that disagreed with the schema would either block a valid
    // code or let an invalid one reach the server — the class of bug this
    // module was created to end.
    const browser = new RegExp(`^${EMAIL_OTP_INPUT_PATTERN}$`);

    for (const value of ['123456', '12345678', '1234567890', '006391']) {
      expect(browser.test(value), value).toBe(isValidEmailOtp(value));
    }
    for (const value of ['12345', '12345678901', '12345a']) {
      expect(browser.test(value), value).toBe(isValidEmailOtp(value));
    }
  });

  it('never names a specific length in the user-facing message', () => {
    // "6-digit code" was wrong the moment the Supabase setting changed.
    expect(EMAIL_OTP_ERROR_MESSAGE).not.toMatch(/\d/);
    expect(EMAIL_OTP_ERROR_MESSAGE.toLowerCase()).toContain('one-time code');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `verifySignInCodeAction` at the boundary: what it forwards to Supabase.
 *
 * The production defect was that an eight-digit code could not be entered *or*
 * validated. These assertions cover the second half — that the action accepts
 * the real production length and hands it to `verifyOtp` byte for byte, with no
 * truncation, no padding and no numeric coercion.
 */

const mocks = vi.hoisted(() => ({
  verifyOtp: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({ auth: { verifyOtp: mocks.verifyOtp } }),
}));

const { verifySignInCodeAction } = await import('@/server/actions/auth');

const EMAIL = 'player@matchday.test';

function submit(token: string, email = EMAIL) {
  const form = new FormData();
  form.set('email', email);
  form.set('token', token);
  form.set('next', '/dashboard');
  return verifySignInCodeAction(null, form);
}

/** The `token` argument the action passed to Supabase. */
function tokenSentToSupabase(): unknown {
  return (mocks.verifyOtp.mock.calls[0]?.[0] as { token?: unknown } | undefined)?.token;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyOtp.mockResolvedValue({ error: null });
});

describe('accepted codes reach Supabase intact', () => {
  it('forwards a six-digit code', async () => {
    await submit('123456');

    expect(mocks.verifyOtp).toHaveBeenCalledTimes(1);
    expect(tokenSentToSupabase()).toBe('123456');
  });

  it('forwards an eight-digit production code without truncating it', async () => {
    // The exact failure found on a physical iPhone.
    await submit('84726193');

    expect(tokenSentToSupabase()).toBe('84726193');
    expect(String(tokenSentToSupabase())).toHaveLength(8);
  });

  it('forwards a ten-digit code', async () => {
    await submit('1234567890');

    expect(tokenSentToSupabase()).toBe('1234567890');
  });

  it('preserves leading zeroes rather than coercing to a number', async () => {
    await submit('00123456');

    // `Number('00123456')` is 123456 — a different code entirely.
    expect(tokenSentToSupabase()).toBe('00123456');
    expect(typeof tokenSentToSupabase()).toBe('string');
  });

  it('strips pasted whitespace before sending', async () => {
    await submit('  8472 6193 ');

    expect(tokenSentToSupabase()).toBe('84726193');
  });

  it('still calls Supabase with the email flow, unchanged', async () => {
    await submit('84726193');

    // The rest of the call is untouched by this fix.
    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      email: EMAIL,
      token: '84726193',
      type: 'email',
    });
  });

  it('lowercases and trims the email as it always did', async () => {
    await submit('123456', '  Player@Matchday.TEST ');

    expect(mocks.verifyOtp).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'player@matchday.test' }),
    );
  });
});

describe('rejected codes never reach Supabase', () => {
  it.each([
    ['too short', '12345'],
    ['too long', '12345678901'],
    ['non-numeric', '12345a'],
    ['empty', ''],
    ['punctuated', '123-456'],
  ])('refuses a %s code without calling verifyOtp', async (_label, token) => {
    const result = await submit(token);

    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(result?.ok).toBe(false);
  });

  it('reports a field error naming no specific length', async () => {
    const result = await submit('12345');

    expect(result?.ok).toBe(false);
    const message = result?.ok === false ? result.fieldErrors['token'] : '';
    expect(message).toBeTruthy();
    // "Enter the 6-digit code" was wrong the moment Supabase was set to eight.
    expect(message).not.toMatch(/\d/);
  });

  it('does not echo the submitted code back to the client', async () => {
    const result = await submit('99999999999');

    // The code is a live credential until spent; it must not travel back in an
    // error payload where it could be logged by the client.
    expect(JSON.stringify(result)).not.toContain('99999999999');
  });
});

describe('a wrong code is reported the same as an expired one', () => {
  it('gives one message for both', async () => {
    mocks.verifyOtp.mockResolvedValue({ error: { message: 'Token has expired' } });

    const result = await submit('84726193');

    expect(result?.ok).toBe(false);
    const message = result?.ok === false ? result.fieldErrors['token'] : '';
    expect(message).toBe('That code is not valid or has expired.');
  });

  it('does not leak the Supabase error text', async () => {
    mocks.verifyOtp.mockResolvedValue({
      error: { message: 'Token has expired or is invalid for user 8f3a-uuid' },
    });

    const result = await submit('84726193');

    expect(JSON.stringify(result)).not.toContain('8f3a-uuid');
  });
});

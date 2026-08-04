import { describe, expect, it } from 'vitest';
import { DEFAULT_POST_SIGN_IN_PATH, safeRedirectPath } from '@/lib/auth/safe-redirect';

describe('safeRedirectPath', () => {
  it('keeps a same-origin path', () => {
    expect(safeRedirectPath('/profile')).toBe('/profile');
    expect(safeRedirectPath('/dashboard?welcome=1')).toBe('/dashboard?welcome=1');
  });

  it('falls back when nothing is supplied', () => {
    expect(safeRedirectPath(null)).toBe(DEFAULT_POST_SIGN_IN_PATH);
    expect(safeRedirectPath(undefined)).toBe(DEFAULT_POST_SIGN_IN_PATH);
    expect(safeRedirectPath('')).toBe(DEFAULT_POST_SIGN_IN_PATH);
  });

  it.each([
    ['https://evil.example/steal', 'an absolute URL'],
    ['//evil.example/steal', 'a protocol-relative URL'],
    ['/\\evil.example', 'a backslash-smuggled origin'],
    ['javascript:alert(1)', 'a javascript: URL'],
    ['profile', 'a relative path with no leading slash'],
    ['/dashboard\nSet-Cookie: a=b', 'an embedded newline'],
    ['/dashboard\r\nLocation: https://evil.example', 'a CRLF injection'],
  ])('rejects %s (%s)', (candidate) => {
    expect(safeRedirectPath(candidate)).toBe(DEFAULT_POST_SIGN_IN_PATH);
  });
});

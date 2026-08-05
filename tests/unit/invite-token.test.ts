import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildInviteUrl,
  generateInviteToken,
  isPlausibleInviteToken,
} from '@/lib/leagues/invite-token';

describe('generateInviteToken', () => {
  it('produces 43 base64url characters — 32 bytes of entropy', () => {
    const token = generateInviteToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('is URL-safe: no padding, no characters needing escaping', () => {
    for (let i = 0; i < 50; i += 1) {
      const token = generateInviteToken();
      expect(token).not.toContain('=');
      expect(token).not.toContain('+');
      expect(token).not.toContain('/');
      expect(encodeURIComponent(token)).toBe(token);
    }
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateInviteToken()));
    expect(tokens.size).toBe(500);
  });

  it('is not derived from anything predictable', () => {
    // A guessable token defeats every other control on an invitation, so this
    // checks the tokens are not merely unique but unrelated: no shared prefix
    // that would narrow a brute-force search.
    const tokens = Array.from({ length: 100 }, () => generateInviteToken());
    const prefixes = new Set(tokens.map((token) => token.slice(0, 8)));
    expect(prefixes.size).toBe(100);
  });

  it('has a digest that reveals nothing about the token', () => {
    // The database stores sha256(token). This documents the relationship the
    // schema relies on: the stored value cannot be turned back into a token.
    const token = generateInviteToken();
    const digest = createHash('sha256').update(token, 'utf8').digest('hex');

    expect(digest).toHaveLength(64);
    expect(digest).not.toContain(token);
    expect(token).not.toContain(digest);
  });
});

describe('isPlausibleInviteToken', () => {
  it('accepts a generated token', () => {
    expect(isPlausibleInviteToken(generateInviteToken())).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['short', 'too short'],
    ['a'.repeat(31), 'just under the minimum'],
    ['a'.repeat(129), 'absurdly long'],
    ['../../etc/passwd', 'a path traversal attempt'],
    ['abcdefghij klmnopqrstuvwxyz0123456789', 'containing a space'],
    ["'; drop table league_invites;--", 'an injection attempt'],
    ['%20'.repeat(20), 'percent-encoded padding'],
  ])('rejects %s (%s)', (candidate) => {
    expect(isPlausibleInviteToken(candidate)).toBe(false);
  });

  it('accepts exactly the boundary lengths', () => {
    expect(isPlausibleInviteToken('a'.repeat(32))).toBe(true);
    expect(isPlausibleInviteToken('a'.repeat(128))).toBe(true);
  });
});

describe('buildInviteUrl', () => {
  it('builds a link from configuration', () => {
    expect(buildInviteUrl('https://matchday.example', 'TOKEN')).toBe(
      'https://matchday.example/invite/TOKEN',
    );
  });

  it('tolerates a trailing slash on the site URL', () => {
    expect(buildInviteUrl('https://matchday.example///', 'TOKEN')).toBe(
      'https://matchday.example/invite/TOKEN',
    );
  });
});

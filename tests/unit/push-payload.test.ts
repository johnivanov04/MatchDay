import { describe, expect, it } from 'vitest';
import {
  buildPushPayload,
  isPushEligible,
  isSafePushUrl,
  serializePushPayload,
  type CanonicalNotificationForPush,
} from '@/lib/push/payload';
import type { NotificationType } from '@/types/database';

const BASE: CanonicalNotificationForPush = {
  id: '11111111-1111-4111-8111-000000000001',
  type: 'match_published',
  title: 'New match: Monday night 11v11',
  body: 'Mon 17 Aug 19:00 at RMV Community Pitch',
  deep_link: '/leagues/rmv-football-club/matches/aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
};

describe('isPushEligible', () => {
  it.each([
    'match_published',
    'match_changed',
    'match_canceled',
    'join_request_approved',
    'join_request_rejected',
    'guideline_acceptance_required',
  ] as NotificationType[])('pushes %s', (type) => {
    expect(isPushEligible(type)).toBe(true);
  });

  it.each([
    'join_request_submitted',
    'league_invitation_accepted',
    'guideline_version_published',
    // A player tidying up their leagues. Administrator housekeeping, like
    // `league_invitation_accepted` from the other direction, and nothing about
    // it needs a phone to light up.
    'member_left',
  ] as NotificationType[])('keeps %s in the app', (type) => {
    // Administrator housekeeping and purely informational updates are not
    // worth interrupting somebody's evening for.
    expect(isPushEligible(type)).toBe(false);
  });

  it('builds no push payload at all for a member leaving', () => {
    // The stronger statement: not merely "not in the set", but that the
    // dispatcher — which skips anything `buildPushPayload` returns null for —
    // has nothing to send.
    expect(buildPushPayload({ ...BASE, type: 'member_left' })).toBeNull();
  });
});

describe('isSafePushUrl', () => {
  it('accepts a same-origin path', () => {
    expect(isSafePushUrl('/leagues/x/matches/y')).toBe(true);
    expect(isSafePushUrl('/dashboard?notice=x')).toBe(true);
  });

  it.each([
    ['https://evil.example/steal', 'an absolute URL'],
    ['//evil.example', 'a protocol-relative URL'],
    ['/\\evil.example', 'a backslash-smuggled origin'],
    ['javascript:alert(1)', 'a javascript URL'],
    ['dashboard', 'a relative path'],
    ['/dashboard\nSet-Cookie: a=b', 'an embedded newline'],
    [`/${'a'.repeat(600)}`, 'an absurdly long path'],
  ])('rejects %s (%s)', (candidate) => {
    expect(isSafePushUrl(candidate)).toBe(false);
  });
});

describe('buildPushPayload', () => {
  it('carries only title, body, url and id', () => {
    const payload = buildPushPayload(BASE);
    expect(payload).not.toBeNull();
    expect(Object.keys(payload ?? {}).sort()).toEqual(['body', 'notificationId', 'title', 'url']);
  });

  it('returns null for a type that is not push-eligible', () => {
    expect(buildPushPayload({ ...BASE, type: 'join_request_submitted' })).toBeNull();
  });

  it('returns null rather than throwing on an unsafe link', () => {
    // One malformed row must not stop the rest of a batch being delivered.
    expect(buildPushPayload({ ...BASE, deep_link: 'https://evil.example' })).toBeNull();
  });

  it('truncates long text rather than sending an oversized payload', () => {
    const payload = buildPushPayload({
      ...BASE,
      title: 'T'.repeat(500),
      body: 'B'.repeat(500),
    });

    expect((payload?.title ?? '').length).toBeLessThanOrEqual(80);
    expect((payload?.body ?? '').length).toBeLessThanOrEqual(160);
    expect(payload?.title).toContain('…');
  });

  describe('never carries anything private', () => {
    it('exposes no field beyond the four allowed', () => {
      // The payload is constructed field by field, not spread from a row, so
      // there is no object that could widen. This asserts the consequence.
      const withExtras = {
        ...BASE,
        // Fields that exist elsewhere in the domain and must never reach a lock
        // screen. They are not part of the input type; the cast is the point.
        phone: '+1-555-0100',
        gender: 'woman',
        admin_notes: 'Suspended after repeated late cancellations',
        roster: ['Jules Okonkwo', 'Priya Raman'],
        attendance: 'no_show',
      } as unknown as CanonicalNotificationForPush;

      const serialized = serializePushPayload(buildPushPayload(withExtras)!);

      for (const secret of [
        '555-0100',
        'woman',
        'Suspended',
        'Okonkwo',
        'no_show',
        'admin_notes',
        'roster',
      ]) {
        expect(serialized).not.toContain(secret);
      }
    });

    it('serialises to exactly four keys', () => {
      const parsed: unknown = JSON.parse(serializePushPayload(buildPushPayload(BASE)!));
      expect(Object.keys(parsed as Record<string, unknown>).sort()).toEqual([
        'body',
        'notificationId',
        'title',
        'url',
      ]);
    });
  });
});

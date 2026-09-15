import { describe, expect, it } from 'vitest';
import {
  CONFIGURABLE_NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_META,
} from '@/lib/notifications/notification-types';
import { isPushEligible } from '@/lib/push/payload';
import { assertLoggable } from '@/lib/observability/log';
import type { NotificationType } from '@/types/database';

/**
 * The registry is display metadata. It must never become the authority on what
 * may leave the building — that is `PUSH_ELIGIBLE_TYPES` — but the two must
 * agree, or Settings offers a switch that governs nothing, or hides one that
 * governs something.
 */

describe('the registry and the delivery rules agree', () => {
  it('marks exactly the externally eligible types as configurable', () => {
    const configurable = new Set(CONFIGURABLE_NOTIFICATION_TYPES);
    const eligible = new Set(
      (Object.keys(NOTIFICATION_TYPE_META) as NotificationType[]).filter(isPushEligible),
    );

    // Symmetric difference, reported both ways so a failure says which.
    const offeredButUndeliverable = [...configurable].filter((t) => !eligible.has(t));
    const deliverableButHidden = [...eligible].filter((t) => !configurable.has(t));

    expect(offeredButUndeliverable).toEqual([]);
    expect(deliverableButHidden).toEqual([]);
  });

  it('keeps attendance_recorded out of Settings', () => {
    // Not merely uninteresting: its body can say "You are recorded as not
    // having attended". There is no external delivery here to configure.
    expect(NOTIFICATION_TYPE_META.attendance_recorded.configurable).toBe(false);
    expect(isPushEligible('attendance_recorded')).toBe(false);
  });

  it('gives every type a human label, never a raw enum name', () => {
    for (const [type, meta] of Object.entries(NOTIFICATION_TYPE_META)) {
      expect(meta.label.length, type).toBeGreaterThan(0);
      // A label containing an underscore is almost certainly the enum leaking.
      expect(meta.label, type).not.toContain('_');
      expect(meta.label, type).not.toBe(type);
    }
  });

  it('covers every notification type — the compiler enforces this, and so does the test', () => {
    // `Record<NotificationType, …>` fails to compile if a type is missing. This
    // catches the other direction: a key that is no longer a real type.
    const known: NotificationType[] = [
      'join_request_submitted', 'join_request_approved', 'join_request_rejected',
      'league_invitation_accepted', 'match_published', 'match_changed', 'match_canceled',
      'guideline_version_published', 'guideline_acceptance_required', 'signup_confirmed',
      'signup_pending', 'waitlisted', 'not_selected', 'roster_published', 'roster_changed',
      'cancellation_receipt', 'late_cancellation', 'waitlist_promotion', 'replacement_needed',
      'reminder', 'teams_published', 'teams_changed', 'attendance_recorded', 'member_left',
      'league_closed',
    ];

    expect(Object.keys(NOTIFICATION_TYPE_META).sort()).toEqual([...known].sort());
  });

  it('offers 17 configurable types', () => {
    expect(CONFIGURABLE_NOTIFICATION_TYPES).toHaveLength(17);
  });
});

describe('the new worker counters survive the log filter', () => {
  it('push_preference_skipped and mail_preference_skipped are not silently dropped', () => {
    // THE FAILURE THIS PREVENTS: a field name containing a forbidden substring
    // is removed from the log line without a word. `mail_preference_skipped` is
    // named that way precisely because anything containing "email" would be
    // eaten — the same trap `reminder.skipped`'s `reason` field fell into.
    expect(
      assertLoggable({
        claimed: 1,
        completed: 1,
        push_preference_skipped: 1,
        mail_preference_skipped: 1,
        sent: 0,
        mail_sent: 0,
      }),
    ).toBe(true);
  });

  it('a name containing "email" would indeed have been dropped', () => {
    // Demonstrating the trap rather than asserting the absence of a bug.
    expect(assertLoggable({ email_preference_skipped: 1 })).toBe(false);
  });
});

describe('the registry cannot authorize delivery', () => {
  /**
   * The registry is display metadata. If a malicious client stored a preference
   * row for an in-app-only type — which the table permits, because policing
   * product policy in a CHECK would be a second place for the eligible set to
   * drift — nothing downstream may act on it.
   *
   * Three independent layers say no, and this proves the two that live in
   * TypeScript. The third is the queue trigger, which never fires for a
   * notification written with `push_eligible: false`; that one is proved
   * against the real database in `tests/db/notification-type-preferences`.
   */
  const IN_APP_ONLY: NotificationType[] = (
    Object.keys(NOTIFICATION_TYPE_META) as NotificationType[]
  ).filter((t) => !NOTIFICATION_TYPE_META[t].configurable);

  it('has eight in-app-only types to defend', () => {
    expect(IN_APP_ONLY).toHaveLength(8);
  });

  it('builds NO push payload for any of them, whatever a preference says', async () => {
    const { buildPushPayload } = await import('@/lib/push/payload');

    for (const type of IN_APP_ONLY) {
      expect(
        buildPushPayload({
          id: '11111111-1111-4111-8111-000000000001',
          type,
          title: 'T',
          body: 'B',
          deep_link: '/leagues/x/matches/y',
        }),
        type,
      ).toBeNull();
    }
  });

  it('the email dispatcher skips all of them, whatever a preference says', async () => {
    const { dispatchEmailNotifications } = await import('@/lib/email/dispatch');

    for (const type of IN_APP_ONLY) {
      const sent: string[] = [];
      const recorded: string[] = [];

      const result = await dispatchEmailNotifications(['11111111-1111-4111-8111-000000000001'], {
        store: {
          loadNotifications: async (ids) =>
            ids.map((id) => ({
              id,
              type,
              title: 'T',
              body: 'B',
              deep_link: '/leagues/x/matches/y',
            })),
          // Deliberately generous: the address resolves, the channel is not
          // settled, and a preference row says yes. The type is still refused.
          resolveRecipient: async () => 'player@example.test',
          loadAttempt: async () => null,
          recordResult: async (_id, status) => {
            recorded.push(status);
          },
        },
        sender: {
          send: async (m) => {
            sent.push(m.to);
            return { ok: true as const };
          },
        },
        baseUrl: 'https://app.matchdayapps.com',
        from: 'MatchDay <notifications@example.test>',
      });

      expect(sent, type).toEqual([]);
      expect(recorded, type).toEqual([]);
      expect(result.attempted, type).toBe(0);
      // Skipped, not failed — and therefore no retry work either.
      expect(result.retryable, type).toBe(0);
    }
  });

  it('the authority is isPushEligible, not the registry', async () => {
    // Stated directly: flipping a registry entry would change what Settings
    // offers and nothing else. The delivery rule is a separate list.
    const { buildPushPayload } = await import('@/lib/push/payload');

    // `attendance_recorded` is marked non-configurable AND is not push
    // eligible. The second fact is the one that governs.
    expect(NOTIFICATION_TYPE_META.attendance_recorded.configurable).toBe(false);
    expect(
      buildPushPayload({
        id: '11111111-1111-4111-8111-000000000001',
        type: 'attendance_recorded',
        title: 'T',
        body: 'B',
        deep_link: '/x/y',
      }),
    ).toBeNull();
  });
});

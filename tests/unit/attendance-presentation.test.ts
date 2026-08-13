import { describe, expect, it } from 'vitest';
import {
  allowedOutcomes,
  ATTENDANCE_OUTCOMES,
  ATTENDANCE_OUTCOME_LABELS,
} from '@/lib/matches/attendance-display';
import { isPushEligible } from '@/lib/push/payload';
import { userMessageFor } from '@/lib/errors';
import { suspendedUntilSchema } from '@/lib/validation/league';
import type { AttendanceOutcome } from '@/types/database';

/**
 * How Phase 7 talks about people.
 *
 * These are not style assertions. The MVP's central rule is that the product
 * records facts and the administrator decides what they mean (04 §1), and the
 * fastest way to break that is a vocabulary that decides for them — so the
 * wording is pinned here where a future change has to argue with it.
 */
describe('attendance vocabulary', () => {
  it('labels every outcome', () => {
    for (const outcome of ATTENDANCE_OUTCOMES) {
      expect(ATTENDANCE_OUTCOME_LABELS[outcome]).toBeTruthy();
    }
  });

  it('offers all five outcomes and no sixth', () => {
    expect([...ATTENDANCE_OUTCOMES].sort()).toEqual([
      'attended',
      'canceled_late',
      'canceled_on_time',
      'excused_absence',
      'no_show',
    ]);
  });

  it('never uses disciplinary or judgemental language', () => {
    // "No-show" is the database's word for the outcome. What a person reads is
    // "Did not attend", which describes what happened without characterising
    // it — the same fact, minus the verdict.
    const banned = [
      'no-show',
      'noshow',
      'offend',
      'strike',
      'penalty',
      'warning',
      'unreliable',
      'reliability',
      'ban',
      'punish',
      'fault',
      'blame',
    ];

    for (const label of Object.values(ATTENDANCE_OUTCOME_LABELS)) {
      for (const word of banned) {
        expect(label.toLowerCase()).not.toContain(word);
      }
    }
  });

  it('leads with the ordinary outcome, not the severe one', () => {
    // Order is a claim about what usually happens. "Attended" first says that
    // most people turn up, which is true of a pickup league.
    expect(ATTENDANCE_OUTCOMES[0]).toBe('attended');
  });
});

describe('which outcomes an administrator is offered', () => {
  it('offers attendance outcomes for somebody who did not withdraw', () => {
    expect([...allowedOutcomes(false)]).toEqual(['attended', 'no_show', 'excused_absence']);
  });

  it('offers cancellation outcomes for somebody who withdrew', () => {
    expect([...allowedOutcomes(true)]).toEqual([
      'canceled_on_time',
      'canceled_late',
      'excused_absence',
    ]);
  });

  it('never offers to mark a player who withdrew as a no-show', () => {
    // They told the league they were not coming. Recording that as a no-show
    // would erase the distinction Phase 5's cancellation cutoff exists to draw.
    expect(allowedOutcomes(true)).not.toContain('no_show');
  });

  it('never offers to mark a player who withdrew as having attended', () => {
    expect(allowedOutcomes(true)).not.toContain('attended');
  });

  it('never offers a cancellation outcome for somebody who never cancelled', () => {
    expect(allowedOutcomes(false)).not.toContain('canceled_on_time');
    expect(allowedOutcomes(false)).not.toContain('canceled_late');
  });

  it('always leaves an excused absence available', () => {
    // The one outcome that fits both, and the correction 02 §16 exists to
    // allow: somebody who could not make it for a reason the administrator
    // accepts, however they left.
    expect(allowedOutcomes(true)).toContain('excused_absence');
    expect(allowedOutcomes(false)).toContain('excused_absence');
  });

  it('only ever offers outcomes that exist', () => {
    const known = new Set<AttendanceOutcome>(ATTENDANCE_OUTCOMES);
    for (const outcome of [...allowedOutcomes(true), ...allowedOutcomes(false)]) {
      expect(known.has(outcome)).toBe(true);
    }
  });
});

describe('attendance never reaches a lock screen', () => {
  it('is not push-eligible', () => {
    // 7Q: the canonical in-app notification is required, the automatic push is
    // not. A push payload renders where anyone glancing at the phone reads it.
    expect(isPushEligible('attendance_recorded')).toBe(false);
  });

  it('leaves the Phase 5 and 6 time-critical types pushing', () => {
    // Guards against somebody "fixing" this by emptying the set.
    expect(isPushEligible('waitlist_promotion')).toBe(true);
    expect(isPushEligible('teams_changed')).toBe(true);
  });
});

describe('the messages an administrator sees', () => {
  it('explains a stale correction in terms of what to do next', () => {
    const message = userMessageFor('ATTENDANCE_REVISION_STALE');
    expect(message).toContain('Reload');
  });

  it('names nobody in an eligibility refusal', () => {
    expect(userMessageFor('ATTENDANCE_NOT_ELIGIBLE')).not.toMatch(/\b(he|she|his|her)\b/i);
  });

  it('says what to do rather than what went wrong when a match is incomplete', () => {
    expect(userMessageFor('ATTENDANCE_INCOMPLETE')).toContain('Record an outcome');
  });
});

describe('the suspension end date', () => {
  it('treats a blank as an indefinite suspension rather than an error', () => {
    expect(suspendedUntilSchema.parse('')).toBeNull();
    expect(suspendedUntilSchema.parse('   ')).toBeNull();
  });

  it('includes the whole of the day the administrator picked', () => {
    // "Suspended until the 30th" means through the 30th, not up to midnight at
    // its start — which would end the suspension a day early.
    const parsed = suspendedUntilSchema.parse('2026-09-30');
    expect(parsed).not.toBeNull();

    const date = new Date(parsed as string);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(8); // September
    expect(date.getDate()).toBe(30);
    expect(date.getHours()).toBe(23);
  });

  it('rejects something that is not a date without throwing at the user', () => {
    expect(suspendedUntilSchema.parse('not a date')).toBeNull();
  });
});

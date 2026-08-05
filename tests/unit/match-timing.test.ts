import { describe, expect, it } from 'vitest';
import {
  formatMatchTime,
  instantToZonedLocalTime,
  zonedLocalTimeToInstant,
} from '@/lib/matches/match-timing';

/**
 * Timezone arithmetic, exercised against the two 2026 US transitions.
 *
 * These are the same instants `tests/db/matches.test.ts` asserts against
 * PostgreSQL's `AT TIME ZONE`. Testing both implementations against the same
 * expected UTC values is what keeps the display layer and the authoritative
 * database conversion from drifting apart.
 */
const LA = 'America/Los_Angeles';

describe('zonedLocalTimeToInstant', () => {
  it('resolves a standard-time evening correctly', () => {
    // 19:00 PST (UTC-8) on 2026-01-15 is 03:00Z the next day.
    const instant = zonedLocalTimeToInstant({ date: '2026-01-15', time: '19:00' }, LA);
    expect(instant.toISOString()).toBe('2026-01-16T03:00:00.000Z');
  });

  it('resolves a daylight-time evening correctly', () => {
    // 19:00 PDT (UTC-7) on 2026-07-15 is 02:00Z the next day.
    const instant = zonedLocalTimeToInstant({ date: '2026-07-15', time: '19:00' }, LA);
    expect(instant.toISOString()).toBe('2026-07-16T02:00:00.000Z');
  });

  describe('spring forward — 2026-03-08', () => {
    it('gives a different UTC instant for the same wall clock either side', () => {
      const before = zonedLocalTimeToInstant({ date: '2026-03-07', time: '19:00' }, LA);
      const after = zonedLocalTimeToInstant({ date: '2026-03-09', time: '19:00' }, LA);

      expect(before.toISOString()).toBe('2026-03-08T03:00:00.000Z');
      expect(after.toISOString()).toBe('2026-03-10T02:00:00.000Z');

      // 48 hours of wall clock, 47 hours of real time. A recurrence rule
      // evaluated at read time is exactly what gets this wrong.
      const hours = (after.getTime() - before.getTime()) / 3_600_000;
      expect(hours).toBe(47);
    });

    it('resolves a time that does not exist the way PostgreSQL does', () => {
      // 02:30 never happens on this date; clocks jump 02:00 → 03:00. Both this
      // helper and `AT TIME ZONE` apply the pre-transition (standard) offset.
      const instant = zonedLocalTimeToInstant({ date: '2026-03-08', time: '02:30' }, LA);
      expect(instant.toISOString()).toBe('2026-03-08T10:30:00.000Z');
    });
  });

  describe('fall back — 2026-11-01', () => {
    it('gives a different UTC instant for the same wall clock either side', () => {
      const before = zonedLocalTimeToInstant({ date: '2026-10-31', time: '19:00' }, LA);
      const after = zonedLocalTimeToInstant({ date: '2026-11-02', time: '19:00' }, LA);

      expect(before.toISOString()).toBe('2026-11-01T02:00:00.000Z');
      expect(after.toISOString()).toBe('2026-11-03T03:00:00.000Z');

      const hours = (after.getTime() - before.getTime()) / 3_600_000;
      expect(hours).toBe(49);
    });

    it('resolves an ambiguous time the way PostgreSQL does', () => {
      // 01:30 happens twice. Both this helper and `AT TIME ZONE` pick the
      // second occurrence, in standard time (PST, UTC-8).
      const instant = zonedLocalTimeToInstant({ date: '2026-11-01', time: '01:30' }, LA);
      expect(instant.toISOString()).toBe('2026-11-01T09:30:00.000Z');
    });
  });

  it('works for a zone with a half-hour offset', () => {
    // Kolkata is UTC+5:30 year round — a case a whole-hour assumption breaks.
    const instant = zonedLocalTimeToInstant({ date: '2026-06-01', time: '19:00' }, 'Asia/Kolkata');
    expect(instant.toISOString()).toBe('2026-06-01T13:30:00.000Z');
  });

  it('works for a southern-hemisphere zone, where the transitions invert', () => {
    // Sydney is UTC+11 in January (daylight time) and UTC+10 in July.
    expect(
      zonedLocalTimeToInstant({ date: '2026-01-15', time: '19:00' }, 'Australia/Sydney').toISOString(),
    ).toBe('2026-01-15T08:00:00.000Z');
    expect(
      zonedLocalTimeToInstant({ date: '2026-07-15', time: '19:00' }, 'Australia/Sydney').toISOString(),
    ).toBe('2026-07-15T09:00:00.000Z');
  });

  it('treats UTC as a fixed offset', () => {
    expect(
      zonedLocalTimeToInstant({ date: '2026-03-08', time: '02:30' }, 'UTC').toISOString(),
    ).toBe('2026-03-08T02:30:00.000Z');
  });

  it('rejects a malformed local time', () => {
    expect(() => zonedLocalTimeToInstant({ date: 'not-a-date', time: '19:00' }, LA)).toThrow();
  });
});

describe('instantToZonedLocalTime', () => {
  it('round-trips an unambiguous time', () => {
    const original = { date: '2026-07-15', time: '19:00' };
    const roundTripped = instantToZonedLocalTime(zonedLocalTimeToInstant(original, LA), LA);
    expect(roundTripped).toEqual(original);
  });

  it('round-trips across both transitions', () => {
    for (const date of ['2026-03-07', '2026-03-09', '2026-10-31', '2026-11-02']) {
      const original = { date, time: '19:00' };
      expect(instantToZonedLocalTime(zonedLocalTimeToInstant(original, LA), LA)).toEqual(original);
    }
  });

  it('renders the league zone, not the reader’s', () => {
    const instant = zonedLocalTimeToInstant({ date: '2026-07-15', time: '19:00' }, LA);

    // The same instant, read in two zones. A player abroad must be shown the
    // time they have to be on the pitch.
    expect(instantToZonedLocalTime(instant, LA).time).toBe('19:00');
    expect(instantToZonedLocalTime(instant, 'Europe/London').time).toBe('03:00');
  });
});

describe('formatMatchTime', () => {
  it('names the zone so the time is unambiguous', () => {
    const instant = zonedLocalTimeToInstant({ date: '2026-07-15', time: '19:00' }, LA);
    const formatted = formatMatchTime(instant, LA);

    expect(formatted).toContain('19:00');
    expect(formatted).toMatch(/GMT-7|PDT/);
  });

  it('reflects the offset change across a transition', () => {
    const winter = formatMatchTime(
      zonedLocalTimeToInstant({ date: '2026-01-15', time: '19:00' }, LA),
      LA,
    );
    const summer = formatMatchTime(
      zonedLocalTimeToInstant({ date: '2026-07-15', time: '19:00' }, LA),
      LA,
    );

    expect(winter).toContain('19:00');
    expect(summer).toContain('19:00');
    expect(winter).not.toBe(summer);
  });
});

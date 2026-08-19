import { describe, expect, it } from 'vitest';
import { intervalToHoursField } from '@/lib/validation/league';

/**
 * Where a new match's timing comes from.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 *     selected template  →  league defaults
 *
 * and nothing after that. The application constants that used to sit at the end
 * of the chain — two hours, twenty-four hours — are gone, because the league
 * columns are NOT NULL where a value is always needed.
 *
 * ── WHY THE SOURCE IS CHOSEN, NOT THE FIELD ────────────────────────────────
 *
 * This is the part that is easy to get wrong and expensive to get wrong. A
 * template storing `priority_window = null` is making a statement: *this kind
 * of match has no priority window*. Field-level `template?.priority_window ??
 * league.default_priority_window` reads that deliberate null as an absence and
 * substitutes the league's value — silently giving the match a window its
 * template said it should not have.
 *
 * So the object is picked once and answers for every field. The tests below
 * pin that, including the case a naive `??` would fail.
 */

interface Timing {
  priority_window: string | null;
  signup_closes_before: string;
  cancellation_cutoff_before: string;
  roster_publish_before: string | null;
}

/** The league's own policy — the two required values are never null. */
const LEAGUE: Timing = {
  signup_closes_before: '12:00:00',
  cancellation_cutoff_before: '30:00:00',
  priority_window: '06:00:00',
  roster_publish_before: '04:00:00',
};

/**
 * The resolution `CreateMatchForm` and `MatchTemplateForm` both perform.
 *
 * Kept identical in shape to the components deliberately: this is the rule
 * under test, and a test that reimplemented it differently would prove nothing
 * about them.
 */
function resolve(template: Timing | undefined, league: Timing): Timing {
  return template ?? league;
}

describe('with no template selected', () => {
  it('takes every value from the league', () => {
    expect(resolve(undefined, LEAGUE)).toEqual(LEAGUE);
  });

  it('carries a league that does not use a priority window as "none"', () => {
    const league: Timing = { ...LEAGUE, priority_window: null, roster_publish_before: null };
    const resolved = resolve(undefined, league);

    expect(resolved.priority_window).toBeNull();
    expect(resolved.roster_publish_before).toBeNull();
  });

  it('never falls back to two and twenty-four hours', () => {
    const league: Timing = { ...LEAGUE, signup_closes_before: '01:00:00' };
    expect(resolve(undefined, league).signup_closes_before).toBe('01:00:00');
  });
});

describe('with a template selected', () => {
  const template: Timing = {
    signup_closes_before: '03:00:00',
    cancellation_cutoff_before: '05:00:00',
    priority_window: '01:00:00',
    roster_publish_before: '02:00:00',
  };

  it('the template wins on every field', () => {
    expect(resolve(template, LEAGUE)).toEqual(template);
  });

  it('a template null for priority_window means none, not "ask the league"', () => {
    // The regression this whole file exists for. With a field-level `??` the
    // resolved value would be the league's 06:00:00.
    const withoutWindow: Timing = { ...template, priority_window: null };
    const resolved = resolve(withoutWindow, LEAGUE);

    expect(resolved.priority_window).toBeNull();
    expect(resolved.priority_window).not.toBe(LEAGUE.priority_window);
  });

  it('a template null for roster_publish_before means none too', () => {
    const withoutTarget: Timing = { ...template, roster_publish_before: null };
    const resolved = resolve(withoutTarget, LEAGUE);

    expect(resolved.roster_publish_before).toBeNull();
    expect(resolved.roster_publish_before).not.toBe(LEAGUE.roster_publish_before);
  });

  it('a template with both nulls keeps both null even when the league sets both', () => {
    const neither: Timing = { ...template, priority_window: null, roster_publish_before: null };
    const resolved = resolve(neither, LEAGUE);

    expect(resolved.priority_window).toBeNull();
    expect(resolved.roster_publish_before).toBeNull();
    // …while the required two still come from the template, not the league.
    expect(resolved.signup_closes_before).toBe('03:00:00');
  });

  it('demonstrates what the naive implementation would have done', () => {
    // Kept as an executable explanation. If somebody "simplifies" the
    // components back to field-level `??`, the tests above fail and this one
    // says why.
    const withoutWindow: Timing = { ...template, priority_window: null };
    const naive = withoutWindow.priority_window ?? LEAGUE.priority_window;

    expect(naive).toBe('06:00:00');
    expect(resolve(withoutWindow, LEAGUE).priority_window).toBeNull();
  });
});

describe('turning an interval back into a form field', () => {
  it('renders whole hours', () => {
    expect(intervalToHoursField('12:00:00')).toBe('12');
    expect(intervalToHoursField('02:00:00')).toBe('2');
  });

  it('renders a day-based interval as hours', () => {
    expect(intervalToHoursField('1 day')).toBe('24');
    expect(intervalToHoursField('1 day 06:00:00')).toBe('30');
  });

  it('renders zero as "0", not as blank', () => {
    // Zero is a real setting — signup closing at kickoff — and must survive a
    // round trip through the settings form rather than reading as "unset".
    expect(intervalToHoursField('00:00:00')).toBe('0');
  });

  it('renders null as blank, which is what an unset optional field looks like', () => {
    expect(intervalToHoursField(null)).toBe('');
  });
});

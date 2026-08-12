import { describe, expect, it } from 'vitest';
import { MATCH_NOTICES, matchPath, matchPathWithNotice, parseMatchNotice } from '@/lib/auth/page-guards';
import { matchCoreDefaults, matchPolicyDefaults } from '@/lib/matches/match-form-defaults';
import { canEditMatch, matchEditMode } from '@/lib/matches/match-permissions';
import { zonedLocalTimeToInstant } from '@/lib/matches/match-timing';
import type { MatchLifecycleStatus, MatchRow } from '@/types/database';

const LOS_ANGELES = 'America/Los_Angeles';

/**
 * Builds a match the way the database would have: local wall-clock times
 * resolved through the league's zone, never through the machine running the
 * test. `TZ` is not set for this suite, so a helper that quietly used the
 * system zone would pass on a developer's laptop and fail in CI.
 */
function matchAt(
  date: string,
  overrides: Partial<MatchRow> = {},
  timezone = LOS_ANGELES,
): MatchRow {
  const at = (time: string) => zonedLocalTimeToInstant({ date, time }, timezone).toISOString();
  const kickoff = at('19:00');

  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
    league_id: '22222222-2222-4222-8222-000000000001',
    template_id: null,
    title: 'Monday night 11v11',
    match_date: date,
    timezone,
    arrival_at: at('18:30'),
    kickoff_at: kickoff,
    end_at: at('20:30'),
    location_name: 'RMV Community Pitch',
    location_map_url: null,
    capacity: 22,
    min_players: 14,
    selection_mode: 'admin_approval',
    waitlist_mode: 'admin_controlled',
    team_count: 2,
    priority_window: '24:00:00',
    priority_window_ends_at: null,
    signup_closes_at: new Date(Date.parse(kickoff) - 6 * 3_600_000).toISOString(),
    cancellation_cutoff_at: new Date(Date.parse(kickoff) - 19 * 3_600_000).toISOString(),
    roster_publish_target_at: new Date(Date.parse(kickoff) - 8 * 3_600_000).toISOString(),
    status: 'open',
    public_notes: null,
    revision: 0,
    roster_revision: 0,
    roster_finalized_at: null,
    team_revision: 0,
    teams_published_at: null,
    created_by: null,
    published_at: '2026-08-01T00:00:00.000Z',
    canceled_at: null,
    cancellation_reason: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('who may edit a match', () => {
  const STATUSES: MatchLifecycleStatus[] = [
    'draft',
    'open',
    'roster_finalized',
    'teams_published',
    'canceled',
    'completed',
  ];

  it.each([
    ['draft', 'draft'],
    ['open', 'published'],
  ] as const)('offers the %s form for a %s match', (status, mode) => {
    expect(matchEditMode(status)).toBe(mode);
  });

  it('offers no form for a canceled match', () => {
    expect(matchEditMode('canceled')).toBeNull();
    expect(canEditMatch(true, 'canceled')).toBe(false);
  });

  it('offers no form for the lifecycle states no code implements yet', () => {
    for (const status of ['roster_finalized', 'teams_published', 'completed'] as const) {
      expect(matchEditMode(status)).toBeNull();
    }
  });

  it('never offers the control to somebody who is not the administrator', () => {
    // The whole truth table, so a new lifecycle status cannot quietly become
    // editable by a player.
    for (const status of STATUSES) {
      expect(canEditMatch(false, status)).toBe(false);
    }
  });

  it('offers the control to the administrator only where a form exists', () => {
    const editable = STATUSES.filter((status) => canEditMatch(true, status));
    expect(editable).toEqual(['draft', 'open']);
  });
});

describe('match notices', () => {
  it('round-trips every notice it defines', () => {
    for (const notice of Object.values(MATCH_NOTICES)) {
      expect(parseMatchNotice(notice)).toBe(notice);
    }
  });

  it('rejects anything it did not define', () => {
    // Display only, but it still reaches the page — an unrecognised value must
    // render nothing rather than be echoed back.
    for (const value of ['', 'deleted', '<script>', 42, null, undefined, ['saved']]) {
      expect(parseMatchNotice(value)).toBeNull();
    }
  });

  it('builds the path the actions redirect to', () => {
    expect(matchPath('rmvfc', 'abc')).toBe('/leagues/rmvfc/matches/abc');
    expect(matchPathWithNotice('rmvfc', 'abc', MATCH_NOTICES.saved)).toBe(
      '/leagues/rmvfc/matches/abc?notice=saved',
    );
  });
});

describe('prefilling the edit form', () => {
  it('shows the times an administrator entered, in the league’s zone', () => {
    const core = matchCoreDefaults(matchAt('2026-09-21'));

    expect(core).toMatchObject({
      match_date: '2026-09-21',
      arrival_time: '18:30',
      kickoff_time: '19:00',
      end_time: '20:30',
      title: 'Monday night 11v11',
      capacity: 22,
      min_players: 14,
      team_count: 2,
    });
  });

  it('renders absent optional fields as empty strings, not "null"', () => {
    const core = matchCoreDefaults(
      matchAt('2026-09-21', { location_map_url: null, public_notes: null }),
    );
    expect(core.location_map_url).toBe('');
    expect(core.public_notes).toBe('');
  });

  it('uses the league’s zone rather than the machine’s', () => {
    // Same instants, different league zone: the wall-clock values must differ.
    const auckland = matchCoreDefaults(matchAt('2026-09-21', {}, 'Pacific/Auckland'));
    expect(auckland.kickoff_time).toBe('19:00');

    const shifted = matchCoreDefaults({
      ...matchAt('2026-09-21', {}, 'Pacific/Auckland'),
      timezone: LOS_ANGELES,
    });
    expect(shifted.kickoff_time).not.toBe('19:00');
  });

  it('recovers deadlines as the lead times they were configured as', () => {
    const policy = matchPolicyDefaults(matchAt('2026-09-21'));

    expect(policy).toEqual({
      selection_mode: 'admin_approval',
      waitlist_mode: 'admin_controlled',
      priority_window_hours: '24',
      signup_closes_before_hours: '6',
      cancellation_cutoff_before_hours: '19',
      roster_publish_before_hours: '8',
    });
  });

  it('leaves an unset roster target and priority window blank', () => {
    const policy = matchPolicyDefaults(
      matchAt('2026-09-21', { priority_window: null, roster_publish_target_at: null }),
    );
    expect(policy.priority_window_hours).toBe('');
    expect(policy.roster_publish_before_hours).toBe('');
  });

  it('reads the “N days” interval form PostgreSQL uses past a day', () => {
    const policy = matchPolicyDefaults(matchAt('2026-09-21', { priority_window: '2 days' }));
    expect(policy.priority_window_hours).toBe('48');

    const mixed = matchPolicyDefaults(
      matchAt('2026-09-21', { priority_window: '1 day 06:00:00' }),
    );
    expect(mixed.priority_window_hours).toBe('30');
  });
});

describe('loading the form and saving it unchanged', () => {
  /**
   * The defect this guards against: prefill and submit disagreeing by an hour,
   * so that opening the edit form and pressing save silently moves the match.
   * Round-tripping through the same zone the row carries has to be the identity.
   */
  const DATES: ReadonlyArray<readonly [string, string]> = [
    ['a winter date', '2026-01-14'],
    ['a summer date', '2026-07-15'],
    ['the day before clocks go forward', '2026-03-07'],
    ['the day clocks go forward', '2026-03-08'],
    ['the day after clocks go forward', '2026-03-09'],
    ['the day before clocks go back', '2026-10-31'],
    ['the day clocks go back', '2026-11-01'],
    ['the day after clocks go back', '2026-11-02'],
  ];

  it.each(DATES)('does not shift the times on %s', (_label, date) => {
    const match = matchAt(date);
    const core = matchCoreDefaults(match);

    const resubmitted = {
      arrival_at: zonedLocalTimeToInstant(
        { date: core.match_date, time: core.arrival_time },
        match.timezone,
      ).toISOString(),
      kickoff_at: zonedLocalTimeToInstant(
        { date: core.match_date, time: core.kickoff_time },
        match.timezone,
      ).toISOString(),
      end_at: zonedLocalTimeToInstant(
        { date: core.match_date, time: core.end_time },
        match.timezone,
      ).toISOString(),
    };

    expect(resubmitted).toEqual({
      arrival_at: match.arrival_at,
      kickoff_at: match.kickoff_at,
      end_at: match.end_at,
    });
  });

  // Auckland's transitions run the opposite way and fall on different dates, so
  // a helper that assumed one hemisphere would fail exactly here.
  it.each([
    ['the day before Auckland clocks go back', '2026-04-04'],
    ['the day Auckland clocks go back', '2026-04-05'],
    ['the day after Auckland clocks go back', '2026-04-06'],
    ['the day before Auckland clocks go forward', '2026-09-26'],
    ['the day Auckland clocks go forward', '2026-09-27'],
    ['the day after Auckland clocks go forward', '2026-09-28'],
  ])('does not shift the times on %s', (_label, date) => {
    const match = matchAt(date, {}, 'Pacific/Auckland');
    const core = matchCoreDefaults(match);

    expect(
      zonedLocalTimeToInstant(
        { date: core.match_date, time: core.kickoff_time },
        match.timezone,
      ).toISOString(),
    ).toBe(match.kickoff_at);
  });

  it('keeps the stored match_date rather than re-deriving it from kickoff', () => {
    // A late kickoff is on a different UTC date. Deriving the date from the
    // instant would move the match a day.
    const match = matchAt('2026-09-21', {
      kickoff_at: zonedLocalTimeToInstant({ date: '2026-09-21', time: '23:30' }, LOS_ANGELES).toISOString(),
    });

    expect(match.kickoff_at.slice(0, 10)).toBe('2026-09-22');
    expect(matchCoreDefaults(match).match_date).toBe('2026-09-21');
  });

  it('round-trips the deadline lead times too', () => {
    const match = matchAt('2026-03-07');
    const policy = matchPolicyDefaults(match);
    const kickoff = Date.parse(match.kickoff_at);

    // Re-derived exactly as update_draft_match() does: kickoff minus the lead.
    expect(
      new Date(kickoff - Number(policy.signup_closes_before_hours) * 3_600_000).toISOString(),
    ).toBe(match.signup_closes_at);
    expect(
      new Date(kickoff - Number(policy.cancellation_cutoff_before_hours) * 3_600_000).toISOString(),
    ).toBe(match.cancellation_cutoff_at);
  });
});

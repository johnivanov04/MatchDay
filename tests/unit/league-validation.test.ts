import { describe, expect, it } from 'vitest';
import {
  createLeagueSchema,
  inviteOptionsSchema,
  leagueSlugSchema,
  memberEmailSchema,
  sanitizeSearchQuery,
  slugifyLeagueName,
  updateLeagueSettingsSchema,
} from '@/lib/validation/league';

const VALID_LEAGUE = {
  name: 'Sunday Futsal',
  slug: 'sunday-futsal',
  general_area: 'Harbour district',
  timezone: 'Europe/Lisbon',
  sport_label: 'Futsal 5v5',
  description: 'Sunday morning futsal.',
  default_capacity: '12',
  default_min_players: '8',
  default_selection_mode: 'first_come',
  default_waitlist_mode: 'automatic',
  default_team_count: '2',
  default_location: '',
  typical_schedule: '',
  gender_field_enabled: false,
  goalkeeper_field_enabled: false,
  // Match timing, as hours from the form. The two required ones carry the
  // values a new league is shown; the optional two are blank, which is how a
  // league says it does not use them.
  default_signup_closes_before: '2',
  default_cancellation_cutoff_before: '24',
  default_priority_window: '',
  default_roster_publish_before: '',
};

describe('createLeagueSchema', () => {
  it('accepts a complete league', () => {
    const result = createLeagueSchema.safeParse(VALID_LEAGUE);
    expect(result.success).toBe(true);
    expect(result.data?.default_capacity).toBe(12);
  });

  it('has no visibility field at all', () => {
    // New leagues are private by product decision, and `create_league()`
    // hard-codes it — there is nothing for a client to supply or override.
    const result = createLeagueSchema.parse({ ...VALID_LEAGUE, visibility: 'searchable' });
    expect(result).not.toHaveProperty('visibility');
  });

  it('rejects a minimum above the capacity', () => {
    const result = createLeagueSchema.safeParse({
      ...VALID_LEAGUE,
      default_capacity: '10',
      default_min_players: '11',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['default_min_players']);
  });

  it('accepts a minimum equal to the capacity', () => {
    const result = createLeagueSchema.safeParse({
      ...VALID_LEAGUE,
      default_capacity: '10',
      default_min_players: '10',
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['default_capacity', '1'],
    ['default_capacity', '201'],
    ['default_team_count', '1'],
    ['default_team_count', '21'],
  ])('rejects %s = %s, matching the CHECK constraint', (field, value) => {
    const result = createLeagueSchema.safeParse({ ...VALID_LEAGUE, [field]: value });
    expect(result.success).toBe(false);
  });

  it('turns blank optional fields into null', () => {
    const result = createLeagueSchema.parse(VALID_LEAGUE);
    expect(result.default_location).toBeNull();
    expect(result.typical_schedule).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    const result = createLeagueSchema.parse({ ...VALID_LEAGUE, name: '  Sunday Futsal  ' });
    expect(result.name).toBe('Sunday Futsal');
  });
});

describe('updateLeagueSettingsSchema', () => {
  it('does not accept a slug, so an edit cannot break existing links', () => {
    const result = updateLeagueSettingsSchema.parse(VALID_LEAGUE);
    expect(result).not.toHaveProperty('slug');
  });

  it('does not accept a visibility change', () => {
    const result = updateLeagueSettingsSchema.parse({ ...VALID_LEAGUE, visibility: 'searchable' });
    expect(result).not.toHaveProperty('visibility');
  });
});

describe('leagueSlugSchema', () => {
  it.each(['sunday-futsal', 'abc', 'league-2026', 'a1-b2-c3'])('accepts %s', (slug) => {
    expect(leagueSlugSchema.safeParse(slug).success).toBe(true);
  });

  it.each([
    ['Not A Slug', 'spaces and capitals'],
    ['-leading', 'a leading hyphen'],
    ['trailing-', 'a trailing hyphen'],
    ['double--hyphen', 'a doubled hyphen'],
    ['ab', 'too short'],
    ['a'.repeat(61), 'too long'],
    ['under_score', 'an underscore'],
    ['../etc', 'path characters'],
  ])('rejects %s (%s)', (slug) => {
    expect(leagueSlugSchema.safeParse(slug).success).toBe(false);
  });

  it('lower-cases what it accepts', () => {
    expect(leagueSlugSchema.parse('Sunday-Futsal')).toBe('sunday-futsal');
  });
});

describe('slugifyLeagueName', () => {
  it.each([
    ['Sunday Futsal', 'sunday-futsal'],
    ['RMV Football Club', 'rmv-football-club'],
    ['  Weeknight   5v5  ', 'weeknight-5v5'],
    ['Café København', 'cafe-kobenhavn'],
    ['!!!', ''],
  ])('turns %s into %s', (input, expected) => {
    expect(slugifyLeagueName(input)).toBe(expected);
  });

  it('never produces a trailing hyphen when truncating', () => {
    const slug = slugifyLeagueName('a '.repeat(60));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('sanitizeSearchQuery', () => {
  it('keeps ordinary words', () => {
    expect(sanitizeSearchQuery('  weeknight   futsal ')).toBe('weeknight futsal');
  });

  it.each([
    ['%', 'an ILIKE wildcard that would match everything'],
    ['_', 'an ILIKE single-character wildcard'],
    [',', "PostgREST's filter separator inside or=(...)"],
    ['(', 'a PostgREST grouping character'],
    ['\\', 'an escape character'],
    ['*', 'a wildcard'],
  ])('strips %s (%s)', (character) => {
    expect(sanitizeSearchQuery(`ab${character}cd`)).not.toContain(character);
  });

  it('neutralises an attempt to append a filter', () => {
    const injected = sanitizeSearchQuery('x%,visibility.eq.private');
    expect(injected).not.toContain(',');
    expect(injected).not.toContain('%');
  });

  it('caps the length', () => {
    expect(sanitizeSearchQuery('a'.repeat(500))).toHaveLength(80);
  });

  it('reduces a query of only wildcards to nothing', () => {
    expect(sanitizeSearchQuery('%%%')).toBe('');
  });
});

describe('inviteOptionsSchema', () => {
  it('treats a blank maximum as unlimited', () => {
    const result = inviteOptionsSchema.parse({
      label: '',
      grants_status: 'active',
      max_uses: '',
      expires_in_days: '14',
    });
    expect(result.max_uses).toBeNull();
    expect(result.label).toBeNull();
  });

  it.each([
    ['0', 'expires_in_days'],
    ['91', 'expires_in_days'],
  ])('rejects %s days', (days) => {
    const result = inviteOptionsSchema.safeParse({
      label: '',
      grants_status: 'active',
      max_uses: '',
      expires_in_days: days,
    });
    expect(result.success).toBe(false);
  });

  it('only allows an invite to grant active or pending', () => {
    for (const status of ['suspended', 'removed', 'league_admin']) {
      const result = inviteOptionsSchema.safeParse({
        label: '',
        grants_status: status,
        max_uses: '',
        expires_in_days: '14',
      });
      expect(result.success, `${status} must be rejected`).toBe(false);
    }
  });
});

describe('memberEmailSchema', () => {
  it('normalises case and whitespace', () => {
    expect(memberEmailSchema.parse('  Player@Example.COM ')).toBe('player@example.com');
  });

  it('rejects a malformed address', () => {
    expect(memberEmailSchema.safeParse('not-an-email').success).toBe(false);
  });
});

describe('match timing defaults', () => {
  it('turns hours into interval literals for the database', () => {
    const result = createLeagueSchema.parse({
      ...VALID_LEAGUE,
      default_signup_closes_before: '12',
      default_cancellation_cutoff_before: '30',
    });

    expect(result.default_signup_closes_before).toBe('12 hours');
    expect(result.default_cancellation_cutoff_before).toBe('30 hours');
  });

  it('keeps a blank optional field as null rather than zero', () => {
    // The distinction the whole feature turns on: "this league has no priority
    // window" is not "a window of zero length". `z.coerce.number()` would turn
    // `''` into `0`, which is why the empty-string branch is matched first.
    const result = createLeagueSchema.parse({
      ...VALID_LEAGUE,
      default_priority_window: '',
      default_roster_publish_before: '',
    });

    expect(result.default_priority_window).toBeNull();
    expect(result.default_roster_publish_before).toBeNull();
  });

  it('keeps an explicit zero as zero', () => {
    const result = createLeagueSchema.parse({
      ...VALID_LEAGUE,
      default_priority_window: '0',
      default_signup_closes_before: '0',
    });

    expect(result.default_priority_window).toBe('0 hours');
    expect(result.default_signup_closes_before).toBe('0 hours');
  });

  it.each([
    ['default_signup_closes_before', '-1'],
    ['default_cancellation_cutoff_before', '-1'],
    ['default_signup_closes_before', '721'],
    ['default_cancellation_cutoff_before', '721'],
    ['default_priority_window', '721'],
    ['default_roster_publish_before', '-5'],
  ])('rejects %s = %s, mirroring the CHECK constraint', (field, value) => {
    const result = createLeagueSchema.safeParse({ ...VALID_LEAGUE, [field]: value });
    expect(result.success).toBe(false);
  });

  it('accepts exactly 720 hours', () => {
    const result = createLeagueSchema.safeParse({
      ...VALID_LEAGUE,
      default_signup_closes_before: '720',
    });
    expect(result.success).toBe(true);
  });

  it('applies the same rules to the settings schema', () => {
    const { slug: _slug, ...withoutSlug } = VALID_LEAGUE;
    const result = updateLeagueSettingsSchema.parse({
      ...withoutSlug,
      default_signup_closes_before: '6',
      default_priority_window: '',
    });

    expect(result.default_signup_closes_before).toBe('6 hours');
    expect(result.default_priority_window).toBeNull();
  });
});

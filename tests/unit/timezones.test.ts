import { describe, expect, it } from 'vitest';
import { supportedTimezones } from '@/lib/leagues/timezones';

/**
 * The picker's contract with the form that uses it.
 *
 * `LeagueForm` renders `<select defaultValue="UTC">`. A browser given a
 * `defaultValue` no `<option>` carries does not error and does not leave the
 * control blank — it silently selects the first option, which in an
 * alphabetical IANA list is `Africa/Abidjan`. That is how every league created
 * without touching the picker ended up in West Africa.
 */
describe('supportedTimezones', () => {
  it('offers UTC, which the runtime list does not contain', () => {
    const zones = supportedTimezones();

    expect(zones).toContain('UTC');
    // First, so the form's default is also the option a person sees before
    // scrolling — not buried between Europe/Uzhgorod and Etc/GMT+9.
    expect(zones[0]).toBe('UTC');
  });

  it('offers real zones as well as the default', () => {
    const zones = supportedTimezones();

    expect(zones).toContain('Europe/Berlin');
    expect(zones.length).toBeGreaterThan(20);
  });

  it('has no duplicates', () => {
    const zones = supportedTimezones();

    expect(new Set(zones).size).toBe(zones.length);
  });
});

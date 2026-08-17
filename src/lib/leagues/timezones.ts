/**
 * IANA timezone identifiers offered in league forms.
 *
 * The database validates the chosen value against `pg_timezone_names` in a
 * trigger, so this list is a convenience for the picker, not the authority. It
 * falls back to a small set if the runtime lacks `Intl.supportedValuesOf`,
 * because an unusable form is worse than a short list.
 */
const FALLBACK_TIMEZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Lisbon',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Athens',
  'Africa/Lagos',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

/**
 * ── WHY `UTC` IS FORCED TO THE FRONT ───────────────────────────────────────
 *
 * `Intl.supportedValuesOf('timeZone')` returns 417 canonical identifiers on
 * Node 22 and **`UTC` is not one of them** — the canonical spelling there is
 * `Etc/UTC`. The create-league form asks for `UTC` as its default, a browser
 * silently falls back to the first `<option>` when the requested value is
 * absent, and the first option alphabetically is `Africa/Abidjan`. So every
 * league created without opening the picker was being stamped Abidjan, and the
 * kickoff time of every match in it displayed in the wrong zone.
 *
 * Nothing rejected it: `Africa/Abidjan` is a real zone, so the database trigger
 * that validates against `pg_timezone_names` was right to accept it.
 */
export function supportedTimezones(): string[] {
  const supported = Intl.supportedValuesOf;
  if (typeof supported !== 'function') {
    return FALLBACK_TIMEZONES;
  }

  try {
    const zones = supported('timeZone');
    if (zones.length === 0) {
      return FALLBACK_TIMEZONES;
    }
    return zones.includes('UTC') ? [...zones] : ['UTC', ...zones];
  } catch {
    return FALLBACK_TIMEZONES;
  }
}

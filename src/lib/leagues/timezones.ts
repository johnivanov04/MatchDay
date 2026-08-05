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

export function supportedTimezones(): string[] {
  const supported = Intl.supportedValuesOf;
  if (typeof supported !== 'function') {
    return FALLBACK_TIMEZONES;
  }

  try {
    const zones = supported('timeZone');
    return zones.length > 0 ? [...zones] : FALLBACK_TIMEZONES;
  } catch {
    return FALLBACK_TIMEZONES;
  }
}

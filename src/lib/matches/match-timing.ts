/**
 * Timezone arithmetic for matches.
 *
 * The database is the authority: `create_match()` resolves a local date and
 * wall-clock time against the league's IANA zone with `AT TIME ZONE`, which
 * knows every daylight-saving rule and keeps knowing them as tzdata is updated.
 * These helpers exist for the two things SQL cannot do here — previewing an
 * instant in a form before anything is saved, and rendering a stored instant
 * back in the league's own zone — and they are tested against the same
 * transitions the database handles so the two cannot silently disagree.
 */

/**
 * The offset, in milliseconds, that `timeZone` was at on `instant`.
 *
 * Derived by formatting the instant in the target zone and reading the parts
 * back. `Intl` is the only timezone database the JavaScript runtime ships, so
 * asking it what the wall clock said is more reliable than any table we could
 * maintain ourselves.
 */
function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value === undefined ? 0 : Number(value);
  };

  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );

  return asUtc - instant.getTime();
}

export interface LocalMatchTime {
  /** `YYYY-MM-DD` in the league's zone. */
  date: string;
  /** `HH:MM` in the league's zone, 24-hour. */
  time: string;
}

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

/**
 * Resolves a local date and wall-clock time in `timeZone` to an absolute
 * instant.
 *
 * A single-pass "subtract the current offset" conversion is wrong for every
 * match in the week around a daylight-saving transition, because the offset at
 * the guess differs from the offset at the answer. So both offsets in play are
 * probed — twelve hours either side, which brackets any transition — and the
 * two candidate instants are compared.
 *
 * WHY THE LATER CANDIDATE WINS. Two local times per year are not a single
 * instant: the hour skipped when clocks go forward does not exist, and the hour
 * repeated when they go back happens twice. PostgreSQL's `AT TIME ZONE`
 * resolves both to standard time, and standard time is the later of the two
 * candidates in either hemisphere — pre-transition for a gap, post-transition
 * for an overlap. Taking the maximum reproduces that exactly.
 *
 * Matching the database matters more than any particular choice being "right":
 * the database is authoritative for stored match times, and a display helper
 * that disagreed with it would show a time nobody is expected at.
 * `tests/db/matches.test.ts` cross-checks the two implementations directly.
 */
export function zonedLocalTimeToInstant(local: LocalMatchTime, timeZone: string): Date {
  const naive = Date.parse(`${local.date}T${local.time}:00Z`);
  if (Number.isNaN(naive)) {
    throw new Error(`Invalid local match time: ${local.date} ${local.time}`);
  }

  const offsetBefore = timeZoneOffsetMs(new Date(naive - TWELVE_HOURS_MS), timeZone);
  const offsetAfter = timeZoneOffsetMs(new Date(naive + TWELVE_HOURS_MS), timeZone);

  // Identical away from a transition, which is almost always.
  return new Date(Math.max(naive - offsetBefore, naive - offsetAfter));
}

/** Renders an instant as the wall clock a member in `timeZone` would read. */
export function instantToZonedLocalTime(instant: Date, timeZone: string): LocalMatchTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return {
    date: `${read('year')}-${read('month')}-${read('day')}`,
    time: `${read('hour')}:${read('minute')}`,
  };
}

/**
 * Human-readable match time, always in the league's zone rather than the
 * reader's.
 *
 * A player in another timezone must see the time they have to be on the pitch,
 * not the time it is where they are sitting. The zone is named in the output so
 * that is unambiguous.
 */
export function formatMatchTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(instant);
}

/** Date only, in the league's zone. */
export function formatMatchDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(instant);
}

/** Subtracts a whole number of hours, for previewing a deadline against kickoff. */
export function subtractHours(instant: Date, hours: number): Date {
  return new Date(instant.getTime() - hours * 60 * 60 * 1000);
}

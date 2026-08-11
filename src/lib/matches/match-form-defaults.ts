import type { MatchCoreDefaults, MatchPolicyDefaults } from '@/components/match-fields';
import { instantToZonedLocalTime } from '@/lib/matches/match-timing';
import type { MatchRow } from '@/types/database';

/**
 * Turning a stored match back into the values an edit form shows.
 *
 * This is the read half of the timezone round trip. The match stores absolute
 * instants plus the league's IANA zone; the form works in local date and
 * wall-clock time. Rendering the instants back through
 * `instantToZonedLocalTime(instant, match.timezone)` — the *league's* zone,
 * never the browser's — is what makes "load the form, save it unchanged"
 * produce the same instants it started with.
 *
 * `match_date` is taken from the stored column rather than re-derived from
 * `kickoff_at`. They agree, but the column is what the administrator originally
 * chose, and around a daylight-saving transition deriving it would be one more
 * place to get an off-by-one date.
 */
export function matchCoreDefaults(match: MatchRow): MatchCoreDefaults {
  const arrival = instantToZonedLocalTime(new Date(match.arrival_at), match.timezone);
  const kickoff = instantToZonedLocalTime(new Date(match.kickoff_at), match.timezone);
  const end = instantToZonedLocalTime(new Date(match.end_at), match.timezone);

  return {
    title: match.title,
    match_date: match.match_date,
    arrival_time: arrival.time,
    kickoff_time: kickoff.time,
    end_time: end.time,
    location_name: match.location_name,
    location_map_url: match.location_map_url ?? '',
    capacity: match.capacity,
    min_players: match.min_players,
    team_count: match.team_count,
    public_notes: match.public_notes ?? '',
  };
}

/**
 * Whole hours between two instants, as the form's number inputs expect.
 *
 * Deadlines are configured as lead times but stored as instants, so the form
 * has to recover the lead. Rounded to the nearest hour because that is the only
 * granularity any form offers; a value that did not survive the round trip
 * would silently move a deadline on every save.
 */
function hoursBetween(later: string, earlier: string): string {
  const delta = new Date(later).getTime() - new Date(earlier).getTime();
  return String(Math.round(delta / 3_600_000));
}

/**
 * PostgreSQL renders an interval as `HH:MM:SS`, or with a leading `N days` once
 * it exceeds a day. Both forms have to come back as hours.
 */
function intervalToHours(interval: string | null): string {
  if (interval === null) {
    return '';
  }

  const days = /(-?\d+)\s+day/.exec(interval);
  const clock = /(-?\d+):(\d{2}):(\d{2})/.exec(interval);

  const dayHours = days === null ? 0 : Number(days[1]) * 24;
  const clockHours =
    clock === null ? 0 : Number(clock[1]) + Number(clock[2]) / 60 + Number(clock[3]) / 3600;

  const total = dayHours + clockHours;
  return total === 0 && days === null && clock === null ? '' : String(Math.round(total));
}

export function matchPolicyDefaults(match: MatchRow): MatchPolicyDefaults {
  return {
    selection_mode: match.selection_mode,
    waitlist_mode: match.waitlist_mode,
    priority_window_hours: intervalToHours(match.priority_window),
    signup_closes_before_hours: hoursBetween(match.kickoff_at, match.signup_closes_at),
    cancellation_cutoff_before_hours: hoursBetween(
      match.kickoff_at,
      match.cancellation_cutoff_at,
    ),
    roster_publish_before_hours:
      match.roster_publish_target_at === null
        ? ''
        : hoursBetween(match.kickoff_at, match.roster_publish_target_at),
  };
}

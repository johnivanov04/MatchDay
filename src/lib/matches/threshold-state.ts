/**
 * Derived participation state for a match (02 §9, "Derived state").
 *
 * `needs_players`, `enough_players` and `full` are *labels computed from
 * counts*, never stored columns — storing them would create a second thing
 * that has to be kept true as every signup and cancellation lands.
 *
 * Phase 4 introduces the signup rows these counts come from. Until then no
 * count exists, and this module says so rather than inventing one: the
 * pre-signup answer is its own state, not a `needs_players` derived from a
 * fabricated zero. Inventing signup records to make a label render would be the
 * one shortcut guaranteed to produce wrong rosters later.
 */

export type MatchParticipationState =
  /** Signup has not been built yet, so no count exists to judge. Phase 3 only. */
  | 'signup_not_open'
  /** Confirmed participants are below the minimum needed to play. */
  | 'needs_players'
  /** The minimum is met and spots remain. */
  | 'enough_players'
  /** Confirmed participants have reached capacity. */
  | 'full';

export interface MatchParticipationCounts {
  /** Participants holding a confirmed spot. */
  confirmed: number;
  /** Capacity for this match. */
  capacity: number;
  /** Minimum needed for the match to go ahead. */
  minPlayers: number;
}

/**
 * Classifies a match from its counts.
 *
 * `counts` is nullable on purpose: passing `null` is how a caller says "there
 * is no signup data", which is the honest state for every match in Phase 3.
 *
 * Ordering matters. `full` is checked before `needs_players` because a match
 * whose capacity is at or below its minimum threshold is *both* at capacity and
 * short of the minimum, and "full" is the more actionable of the two — there is
 * nothing a member can do about the other.
 */
export function deriveMatchParticipationState(
  counts: MatchParticipationCounts | null,
): MatchParticipationState {
  if (counts === null) {
    return 'signup_not_open';
  }

  const { confirmed, capacity, minPlayers } = counts;

  if (confirmed >= capacity) {
    return 'full';
  }
  if (confirmed < minPlayers) {
    return 'needs_players';
  }
  return 'enough_players';
}

/** How many spots remain, or `null` when there is no signup data yet. */
export function remainingSpots(counts: MatchParticipationCounts | null): number | null {
  if (counts === null) {
    return null;
  }
  return Math.max(0, counts.capacity - counts.confirmed);
}

const STATE_LABELS: Record<MatchParticipationState, string> = {
  signup_not_open: 'Signup opens in a later phase',
  needs_players: 'Needs players',
  enough_players: 'Enough players',
  full: 'Full',
};

export function participationStateLabel(state: MatchParticipationState): string {
  return STATE_LABELS[state];
}

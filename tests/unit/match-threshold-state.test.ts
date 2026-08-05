import { describe, expect, it } from 'vitest';
import {
  deriveMatchParticipationState,
  participationStateLabel,
  remainingSpots,
} from '@/lib/matches/threshold-state';

describe('deriveMatchParticipationState', () => {
  it('reports the pre-signup state when there is no count', () => {
    // Phase 3 has no signup rows. Saying so is the honest answer; deriving
    // `needs_players` from a fabricated zero would be a label the data does
    // not support.
    expect(deriveMatchParticipationState(null)).toBe('signup_not_open');
  });

  it('reports needs_players below the minimum', () => {
    expect(
      deriveMatchParticipationState({ confirmed: 6, capacity: 22, minPlayers: 14 }),
    ).toBe('needs_players');
  });

  it('reports enough_players at the minimum with spots left', () => {
    expect(
      deriveMatchParticipationState({ confirmed: 14, capacity: 22, minPlayers: 14 }),
    ).toBe('enough_players');
  });

  it('reports full at capacity', () => {
    expect(
      deriveMatchParticipationState({ confirmed: 22, capacity: 22, minPlayers: 14 }),
    ).toBe('full');
  });

  it('reports full beyond capacity, rather than a nonsense state', () => {
    expect(
      deriveMatchParticipationState({ confirmed: 25, capacity: 22, minPlayers: 14 }),
    ).toBe('full');
  });

  it('prefers full when capacity is at or below the minimum', () => {
    // A misconfigured match is simultaneously "at capacity" and "short of the
    // minimum". `full` is the more actionable label: there is nothing a member
    // can do about the other.
    expect(
      deriveMatchParticipationState({ confirmed: 10, capacity: 10, minPlayers: 12 }),
    ).toBe('full');
  });

  it('reports enough_players when nothing is required', () => {
    expect(
      deriveMatchParticipationState({ confirmed: 0, capacity: 10, minPlayers: 0 }),
    ).toBe('enough_players');
  });

  it('reports needs_players for an empty match that needs anybody', () => {
    expect(
      deriveMatchParticipationState({ confirmed: 0, capacity: 10, minPlayers: 1 }),
    ).toBe('needs_players');
  });
});

describe('remainingSpots', () => {
  it('is null when there is no signup data', () => {
    expect(remainingSpots(null)).toBeNull();
  });

  it('counts down to zero and never below', () => {
    expect(remainingSpots({ confirmed: 8, capacity: 22, minPlayers: 14 })).toBe(14);
    expect(remainingSpots({ confirmed: 22, capacity: 22, minPlayers: 14 })).toBe(0);
    expect(remainingSpots({ confirmed: 30, capacity: 22, minPlayers: 14 })).toBe(0);
  });
});

describe('participationStateLabel', () => {
  it('has a label for every state', () => {
    for (const state of ['signup_not_open', 'needs_players', 'enough_players', 'full'] as const) {
      expect(participationStateLabel(state).length).toBeGreaterThan(0);
    }
  });

  it('does not promise signup before it exists', () => {
    expect(participationStateLabel('signup_not_open')).toContain('later phase');
  });
});

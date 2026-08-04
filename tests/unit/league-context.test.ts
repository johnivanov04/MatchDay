import { describe, expect, it } from 'vitest';
import {
  buildLeagueSwitcherModel,
  resolveActiveMembership,
  shouldShowLeagueSwitcher,
} from '@/lib/leagues/league-context';
import type { LeagueMembershipWithLeague } from '@/lib/auth/authorization';
import type { LeagueMembershipRow, LeagueRow, MembershipStatus } from '@/types/database';

function entry(
  name: string,
  status: MembershipStatus,
  role: LeagueMembershipRow['role'] = 'player',
): LeagueMembershipWithLeague {
  const id = `league-${name.toLowerCase().replaceAll(' ', '-')}`;
  const league = { id, name } as LeagueRow;
  const membership = { id: `m-${id}`, league_id: id, status, role } as LeagueMembershipRow;
  return { league, membership };
}

describe('buildLeagueSwitcherModel', () => {
  it('separates active, pending and suspended memberships', () => {
    const model = buildLeagueSwitcherModel([
      entry('Alpha', 'active'),
      entry('Bravo', 'pending'),
      entry('Charlie', 'suspended'),
    ]);

    expect(model.active.map((e) => e.league.name)).toEqual(['Alpha']);
    expect(model.pending.map((e) => e.league.name)).toEqual(['Bravo']);
    expect(model.suspended.map((e) => e.league.name)).toEqual(['Charlie']);
  });

  it('omits removed memberships entirely', () => {
    const model = buildLeagueSwitcherModel([entry('Alpha', 'active'), entry('Gone', 'removed')]);

    const everything = [...model.active, ...model.pending, ...model.suspended];
    expect(everything.map((e) => e.league.name)).toEqual(['Alpha']);
  });

  it('sorts each group by league name so the order is stable across loads', () => {
    const model = buildLeagueSwitcherModel([
      entry('Zulu', 'active'),
      entry('Alpha', 'active'),
      entry('Mike', 'active'),
    ]);

    expect(model.active.map((e) => e.league.name)).toEqual(['Alpha', 'Mike', 'Zulu']);
  });

  it('handles a user with no memberships', () => {
    const model = buildLeagueSwitcherModel([]);
    expect(model).toEqual({ active: [], pending: [], suspended: [] });
  });
});

describe('resolveActiveMembership', () => {
  it('honours a stored preference that is still valid', () => {
    const memberships = [entry('Alpha', 'active'), entry('Bravo', 'active')];
    const resolved = resolveActiveMembership(memberships, 'league-bravo');
    expect(resolved?.league.name).toBe('Bravo');
  });

  it('falls back to the first active league when the preference is unknown', () => {
    const memberships = [entry('Zulu', 'active'), entry('Alpha', 'active')];
    const resolved = resolveActiveMembership(memberships, 'league-deleted');
    expect(resolved?.league.name).toBe('Alpha');
  });

  it('drops a stored preference whose membership is no longer active', () => {
    // A player suspended between visits must not keep working in that league.
    const memberships = [entry('Alpha', 'suspended'), entry('Bravo', 'active')];
    const resolved = resolveActiveMembership(memberships, 'league-alpha');
    expect(resolved?.league.name).toBe('Bravo');
  });

  it('drops a stored preference whose membership is only pending', () => {
    const memberships = [entry('Alpha', 'pending'), entry('Bravo', 'active')];
    const resolved = resolveActiveMembership(memberships, 'league-alpha');
    expect(resolved?.league.name).toBe('Bravo');
  });

  it('returns null when nothing is active', () => {
    expect(resolveActiveMembership([entry('Alpha', 'pending')], 'league-alpha')).toBeNull();
    expect(resolveActiveMembership([], null)).toBeNull();
  });

  it('never resolves to a removed membership', () => {
    expect(resolveActiveMembership([entry('Alpha', 'removed')], 'league-alpha')).toBeNull();
  });

  it('resolves the same league for a multi-league player on every call', () => {
    const memberships = [entry('RMV Football Club', 'active'), entry('Weeknight 5v5', 'active')];
    const first = resolveActiveMembership(memberships, null);
    const second = resolveActiveMembership([...memberships].reverse(), null);
    expect(first?.league.id).toBe(second?.league.id);
  });
});

describe('shouldShowLeagueSwitcher', () => {
  it('hides the control for a single membership', () => {
    expect(shouldShowLeagueSwitcher(buildLeagueSwitcherModel([entry('Alpha', 'active')]))).toBe(
      false,
    );
  });

  it('shows the control once a second relationship exists, even a pending one', () => {
    const model = buildLeagueSwitcherModel([entry('Alpha', 'active'), entry('Bravo', 'pending')]);
    expect(shouldShowLeagueSwitcher(model)).toBe(true);
  });
});

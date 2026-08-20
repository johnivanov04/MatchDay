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
  // `closed_at` is explicit: a closed league is excluded from the active set
  // and from the fallback, so leaving it undefined would quietly test a
  // different rule from the one production runs.
  const league = { id, name, closed_at: null } as LeagueRow;
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
    expect(model).toEqual({ active: [], pending: [], suspended: [], closed: [] });
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

/** The same, in a league that has been permanently closed. */
function closedEntry(name: string, status: MembershipStatus = 'active'): LeagueMembershipWithLeague {
  const built = entry(name, status);
  return {
    ...built,
    league: { ...built.league, closed_at: '2026-08-23T10:00:00Z' } as LeagueRow,
  };
}

describe('closed leagues', () => {
  it('are grouped apart from the leagues somebody can still play in', () => {
    // The membership stays `active` on purpose — that is what keeps historical
    // matches readable — so the grouping is a question about the league.
    const model = buildLeagueSwitcherModel([entry('Alpha', 'active'), closedEntry('Zulu')]);

    expect(model.active.map((e) => e.league.name)).toEqual(['Alpha']);
    expect(model.closed.map((e) => e.league.name)).toEqual(['Zulu']);
  });

  it('leave out a membership that was removed as well', () => {
    expect(buildLeagueSwitcherModel([closedEntry('Zulu', 'removed')]).closed).toEqual([]);
  });

  it('are never chosen as the working context', () => {
    // Nothing can be done in one — no match created, nobody joining — so making
    // it active would hand somebody a screen of controls that all refuse.
    expect(resolveActiveMembership([closedEntry('Zulu')], null)).toBeNull();
  });

  it('are not resurrected by a stored preference', () => {
    const closed = closedEntry('Zulu');
    expect(resolveActiveMembership([closed], closed.league.id)).toBeNull();
  });

  it('yield to an open league in the fallback', () => {
    const open = entry('Alpha', 'active');
    const closed = closedEntry('Zulu');

    expect(resolveActiveMembership([closed, open], closed.league.id)?.league.name).toBe('Alpha');
  });

  it('still count towards showing the switcher at all', () => {
    // Somebody with one open and one closed league needs a way to reach the
    // closed one's history.
    expect(
      shouldShowLeagueSwitcher(buildLeagueSwitcherModel([entry('Alpha', 'active'), closedEntry('Zulu')])),
    ).toBe(true);
  });
});

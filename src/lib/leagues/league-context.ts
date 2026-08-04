import type { LeagueMembershipWithLeague } from '@/lib/auth/authorization';

/**
 * Pure active-league selection logic, kept free of Supabase and React so the
 * rules can be unit-tested directly (tests/unit/league-context.test.ts).
 */

export interface LeagueSwitcherModel {
  /** Leagues the user can actually work in. */
  active: LeagueMembershipWithLeague[];
  /** Shown separately in the switcher, per PRD §11. */
  pending: LeagueMembershipWithLeague[];
  /** Visible so the user understands why they cannot act, rather than seeing nothing. */
  suspended: LeagueMembershipWithLeague[];
}

function byLeagueName(a: LeagueMembershipWithLeague, b: LeagueMembershipWithLeague): number {
  return a.league.name.localeCompare(b.league.name, 'en');
}

/**
 * Splits memberships into the groups the switcher renders. Removed memberships
 * never appear: a removed member has no relationship left to show.
 */
export function buildLeagueSwitcherModel(
  memberships: readonly LeagueMembershipWithLeague[],
): LeagueSwitcherModel {
  return {
    active: memberships.filter((entry) => entry.membership.status === 'active').sort(byLeagueName),
    pending: memberships.filter((entry) => entry.membership.status === 'pending').sort(byLeagueName),
    suspended: memberships
      .filter((entry) => entry.membership.status === 'suspended')
      .sort(byLeagueName),
  };
}

/**
 * Chooses the league to work in.
 *
 * The stored preference wins, but only if it still names a league where the
 * user is *active* — a membership can be suspended or removed between visits,
 * and a stale preference must never keep a working context alive. Otherwise the
 * first active membership by league name is used, so the choice is stable
 * across page loads rather than dependent on row order.
 *
 * Returns `null` when the user has no active membership at all, which is a
 * legitimate state: someone whose only membership is still pending.
 */
export function resolveActiveMembership(
  memberships: readonly LeagueMembershipWithLeague[],
  storedActiveLeagueId: string | null,
): LeagueMembershipWithLeague | null {
  const active = memberships.filter((entry) => entry.membership.status === 'active');

  if (storedActiveLeagueId !== null) {
    const stored = active.find((entry) => entry.league.id === storedActiveLeagueId);
    if (stored !== undefined) {
      return stored;
    }
  }

  return [...active].sort(byLeagueName)[0] ?? null;
}

/** True when the switcher control is worth rendering at all (PRD §11). */
export function shouldShowLeagueSwitcher(model: LeagueSwitcherModel): boolean {
  return model.active.length + model.pending.length + model.suspended.length > 1;
}

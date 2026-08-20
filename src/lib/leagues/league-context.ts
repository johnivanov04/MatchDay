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
  /**
   * Leagues that have been permanently closed.
   *
   * The membership is still `active` — that is what keeps historical matches
   * readable — but nothing new happens there, so it is grouped apart rather
   * than sitting among leagues somebody can still play in.
   */
  closed: LeagueMembershipWithLeague[];
}

/**
 * Whether this membership is in a league that is still running.
 *
 * A closed league keeps its members `active` on purpose: their history stays
 * reachable and their record of having played is untouched. So "can I still do
 * something here?" is a question about the league, not about the membership,
 * and every place that used to ask only about status now has to ask both.
 */
function isOpen(entry: LeagueMembershipWithLeague): boolean {
  // `?? null`, so a league row assembled without the column reads as open
  // rather than as closed. The strict form would hide every league from the
  // switcher the moment a projection stopped selecting `closed_at` — and
  // "everything vanished" is a far worse failure than "a closed league lingers
  // for one release", which the database refuses to act on anyway.
  return (entry.league.closed_at ?? null) === null;
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
    active: memberships
      .filter((entry) => entry.membership.status === 'active' && isOpen(entry))
      .sort(byLeagueName),
    pending: memberships.filter((entry) => entry.membership.status === 'pending').sort(byLeagueName),
    suspended: memberships
      .filter((entry) => entry.membership.status === 'suspended')
      .sort(byLeagueName),
    closed: memberships
      .filter((entry) => entry.membership.status !== 'removed' && !isOpen(entry))
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
 * A CLOSED LEAGUE IS NEVER CHOSEN, however the preference got there. Nothing
 * can be done in one — no match can be created, nobody can join — so making it
 * the working context would hand somebody a screen of controls that all refuse.
 * A stored preference pointing at a league that has since closed is treated
 * exactly like one pointing at a membership that has since been removed.
 *
 * Returns `null` when the user has no active membership at all, which is a
 * legitimate state: someone whose only membership is still pending, or whose
 * only league has closed.
 */
export function resolveActiveMembership(
  memberships: readonly LeagueMembershipWithLeague[],
  storedActiveLeagueId: string | null,
): LeagueMembershipWithLeague | null {
  const active = memberships.filter(
    (entry) => entry.membership.status === 'active' && isOpen(entry),
  );

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
  return (
    model.active.length + model.pending.length + model.suspended.length + model.closed.length > 1
  );
}

import { Badge } from '@/components/ui/badge';
import { Section } from '@/components/ui/card';
import type { LeagueSwitcherModel } from '@/lib/leagues/league-context';

/**
 * Memberships that exist but cannot be worked in.
 *
 * ── WHAT THIS IS THE REMAINS OF ────────────────────────────────────────────
 *
 * This was `LeagueSwitcher`: a `<select>`, a Switch button, and — underneath
 * them — these rows. The switching half moved into the league menu behind the
 * active-league strip, which is where somebody looks for it and where it is
 * reachable from every screen rather than from the dashboard only.
 *
 * The rows stayed, because they are not a switcher. PRD §11 asks that a pending
 * or suspended membership be *visible*: somebody who asked to join a league a
 * week ago needs to see that they asked, and somebody who has been suspended
 * needs to know why they cannot act, rather than seeing nothing at all.
 *
 * ── WHY THE DASHBOARD ONLY RENDERS IT WITH NO ACTIVE LEAGUE ────────────────
 *
 * The league menu shows the same rows. When there *is* an active league the
 * strip is on the dashboard too, forty pixels above this, and the two together
 * would be the duplication this change set out to remove. When there is not,
 * the strip does not render at all — and this becomes the only place a person
 * whose sole membership is still pending can see that it exists.
 */
export function MembershipNotices({ model }: { model: LeagueSwitcherModel }) {
  if (model.pending.length === 0 && model.suspended.length === 0) {
    return null;
  }

  return (
    <Section title="Your other memberships">
      <ul className="flex flex-col gap-2">
        {model.pending.map(({ league }) => (
          <li
            key={league.id}
            className="surface-card flex items-center justify-between gap-3 px-3.5 py-3"
          >
            <span className="min-w-0 truncate text-sm font-medium">{league.name}</span>
            <Badge tone="pending" dot>
              Awaiting approval
            </Badge>
          </li>
        ))}
        {model.suspended.map(({ league }) => (
          <li
            key={league.id}
            className="surface-card flex items-center justify-between gap-3 px-3.5 py-3"
          >
            <span className="min-w-0 truncate text-sm font-medium">{league.name}</span>
            <Badge tone="off" dot>
              Suspended
            </Badge>
          </li>
        ))}
      </ul>
    </Section>
  );
}

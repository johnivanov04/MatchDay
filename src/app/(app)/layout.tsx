import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { requireOnboardedUser } from '@/lib/auth/page-guards';
import { getLeagueContext } from '@/lib/leagues/active-league';
import { getUnreadNotificationCount } from '@/lib/notifications/notifications';

/**
 * Guard for every authenticated page.
 *
 * Note that the pages beneath this layout guard themselves as well. That is not
 * redundancy for its own sake: the App Router renders a layout and its page
 * concurrently, so this redirect does not prevent the page from running.
 * `getSessionUser` and `getCurrentProfile` are both wrapped in React's `cache`,
 * so guarding in both places costs no extra queries.
 */
export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const { profile } = await requireOnboardedUser();
  const [leagueContext, unreadNotifications] = await Promise.all([
    getLeagueContext(),
    getUnreadNotificationCount(),
  ]);

  return (
    <AppShell
      displayName={profile.first_name}
      leagueContext={leagueContext}
      unreadNotifications={unreadNotifications}
    >
      {children}
    </AppShell>
  );
}

import type { Metadata } from 'next';
import { LeagueForm } from '@/components/league-form';
import { requireOnboardedUser } from '@/lib/auth/page-guards';
import { supportedTimezones } from '@/lib/leagues/timezones';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Create a league' };

/**
 * Any signed-in user with a completed profile may create a league and becomes
 * its sole administrator (04 §3). The guard here is a convenience; the real
 * check is inside `create_league()`, which any POST must go through.
 */
export default async function NewLeaguePage() {
  await requireOnboardedUser();

  return (
    <>
      <PageHeader
        title="Create a league"
        description="You will be its administrator. Everything here can be changed later."
        back={{ href: '/leagues/discover', label: 'Back to search' }}
      />

      <LeagueForm mode="create" timezones={supportedTimezones()} />
    </>
  );
}

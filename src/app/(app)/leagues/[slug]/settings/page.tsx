import type { Metadata } from 'next';
import { LeagueForm } from '@/components/league-form';
import { LeagueVisibilityControl } from '@/components/league-visibility-control';
import { requireLeagueAdminPage } from '@/lib/auth/page-guards';
import { supportedTimezones } from '@/lib/leagues/timezones';
import { ButtonLink } from '@/components/ui/button';
import { ShieldIcon, UsersIcon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'League settings' };

export default async function LeagueSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // Resolves the slug through the caller's own memberships and asserts active
  // administration. Anyone else — a player, a former administrator, or someone
  // guessing a slug — is redirected to the dashboard rather than meeting a
  // thrown error mid-render.
  const { league } = await requireLeagueAdminPage(slug);

  return (
    <>
      <PageHeader
        eyebrow={league.name}
        icon={<ShieldIcon size={13} />}
        title="League settings"
        description="Defaults for new matches, who can find this league, and who runs it."
        actions={
          <ButtonLink href={`/leagues/${league.slug}/members`} icon={<UsersIcon size={16} />}>
            Manage members and invitations
          </ButtonLink>
        }
      />

      <LeagueVisibilityControl leagueId={league.id} visibility={league.visibility} />

      <LeagueForm mode="settings" league={league} timezones={supportedTimezones()} />
    </>
  );
}

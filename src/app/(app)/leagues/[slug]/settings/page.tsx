import type { Metadata } from 'next';
import Link from 'next/link';
import { LeagueForm } from '@/components/league-form';
import { LeagueVisibilityControl } from '@/components/league-visibility-control';
import { requireLeagueAdminPage } from '@/lib/auth/page-guards';
import { supportedTimezones } from '@/lib/leagues/timezones';

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
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-muted">{league.name}</p>
        <h1 className="text-2xl font-bold">League settings</h1>
        <Link
          href={`/leagues/${league.slug}/members`}
          className="mt-1 text-sm font-semibold underline underline-offset-4"
        >
          Manage members and invitations
        </Link>
      </header>

      <LeagueVisibilityControl leagueId={league.id} visibility={league.visibility} />

      <LeagueForm mode="settings" league={league} timezones={supportedTimezones()} />
    </>
  );
}

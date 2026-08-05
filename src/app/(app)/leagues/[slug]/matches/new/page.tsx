import type { Metadata } from 'next';
import { CreateMatchForm } from '@/components/create-match-form';
import { requireLeagueAdminPage } from '@/lib/auth/page-guards';
import { getLeagueMatchTemplates } from '@/lib/matches/matches';

export const metadata: Metadata = { title: 'Create a match' };

export default async function NewMatchPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { league } = await requireLeagueAdminPage(slug);
  const templates = await getLeagueMatchTemplates(league.id);

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-muted">{league.name}</p>
        <h1 className="text-2xl font-bold">Create a match</h1>
        <p className="text-sm text-muted">
          Start from a template or from scratch. Everything stays editable until you publish.
        </p>
      </header>

      <CreateMatchForm league={league} templates={templates} />
    </>
  );
}

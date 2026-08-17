import type { Metadata } from 'next';
import { CreateMatchForm } from '@/components/create-match-form';
import { requireLeagueAdminPage } from '@/lib/auth/page-guards';
import { getLeagueMatchTemplates } from '@/lib/matches/matches';
import { BallIcon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';

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
      <PageHeader
        eyebrow={league.name}
        icon={<BallIcon size={13} />}
        title="Create a match"
        description="Start from a template or from scratch. Everything stays editable until you publish."
        back={{ href: `/leagues/${league.slug}/matches`, label: 'Back to matches' }}
      />

      <CreateMatchForm league={league} templates={templates} />
    </>
  );
}

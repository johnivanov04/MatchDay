import type { Metadata } from 'next';
import Link from 'next/link';
import { MatchTemplateForm } from '@/components/matches';
import { requireLeagueAdminPage } from '@/lib/auth/page-guards';
import { getLeagueMatchTemplates } from '@/lib/matches/matches';

export const metadata: Metadata = { title: 'Match templates' };

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default async function MatchTemplatesPage({
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
        <h1 className="text-2xl font-bold">Match templates</h1>
        <p className="text-sm text-muted">
          Recurring settings for the matches this league runs. Editing a template never changes a
          match that has already been created from it.
        </p>
        <Link
          href={`/leagues/${league.slug}/matches`}
          className="mt-1 text-sm font-semibold underline underline-offset-4"
        >
          Back to matches
        </Link>
      </header>

      {templates.map((template) => (
        <section key={template.id} className="surface-card flex flex-col gap-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-base font-semibold">{template.name}</h2>
            <span className="shrink-0 text-xs text-muted">
              {template.day_of_week === null
                ? 'No fixed day'
                : (DAY_NAMES[template.day_of_week] ?? '')}
              {template.is_active ? '' : ' · inactive'}
            </span>
          </div>
          <MatchTemplateForm leagueId={league.id} template={template} />
        </section>
      ))}

      <section className="surface-card flex flex-col gap-3 p-4">
        <h2 className="text-base font-semibold">New template</h2>
        <MatchTemplateForm leagueId={league.id} />
      </section>
    </>
  );
}

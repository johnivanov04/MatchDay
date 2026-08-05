import type { Metadata } from 'next';
import Link from 'next/link';
import { AcceptGuidelinesForm } from '@/components/guidelines';
import { requireLeagueMemberPage } from '@/lib/auth/page-guards';
import { getMemberGuidelineView } from '@/lib/guidelines/guidelines';

export const metadata: Metadata = { title: 'Guidelines' };

/**
 * The member-facing guidelines page, and the deep-link target for
 * `guideline_acceptance_required` notifications.
 *
 * Authorization is re-checked here, not assumed from the link: somebody whose
 * membership was removed after the notification was sent is redirected rather
 * than shown member-only text.
 */
export default async function LeagueGuidelinesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { league, isAdmin } = await requireLeagueMemberPage(slug);
  const view = await getMemberGuidelineView(league.id);

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-muted">{league.name}</p>
        <h1 className="text-2xl font-bold">Guidelines</h1>
        {isAdmin ? (
          <Link
            href={`/leagues/${league.slug}/guidelines/manage`}
            className="mt-1 text-sm font-semibold underline underline-offset-4"
          >
            Manage guideline versions
          </Link>
        ) : null}
      </header>

      {view.required === null ? (
        <section className="surface-card p-4">
          <h2 className="text-base font-semibold">Nothing to accept</h2>
          <p className="mt-1 text-sm text-muted">
            This league does not currently require you to accept any guidelines.
          </p>
        </section>
      ) : view.accepted ? (
        <section className="surface-card p-4">
          <h2 className="text-base font-semibold">You are up to date</h2>
          <p className="mt-1 text-sm text-muted">
            You accepted <strong>{view.required.version_label}</strong>. If the league publishes a
            new version you will be asked again.
          </p>
        </section>
      ) : (
        <section className="surface-card flex flex-col gap-4 p-4">
          <div>
            <h2 className="text-base font-semibold">Acceptance needed</h2>
            <p className="mt-1 text-sm text-muted">
              You need to accept these guidelines before you can sign up for matches in this
              league. This does not affect any other league you belong to.
            </p>
          </div>

          <article className="whitespace-pre-wrap rounded-lg border border-[var(--border-subtle)] p-3 text-sm">
            {view.required.body}
          </article>

          {view.required.document_url === null ? null : (
            <a
              href={view.required.document_url}
              rel="noopener noreferrer"
              target="_blank"
              className="text-sm underline underline-offset-4"
            >
              Read the full document
            </a>
          )}

          <AcceptGuidelinesForm version={view.required} />
        </section>
      )}

      {view.published.length === 0 ? null : (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">All published versions</h2>
          <ul className="flex flex-col gap-2">
            {view.published.map((version) => (
              <li key={version.id} className="surface-card p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{version.title}</p>
                    <p className="text-xs text-muted">
                      {version.version_label}
                      {version.archived_at === null ? '' : ' · archived'}
                      {version.requires_acceptance ? ' · acceptance required' : ''}
                    </p>
                  </div>
                  {view.acceptedVersionIds.has(version.id) ? (
                    <span className="shrink-0 text-xs font-medium text-pitch-600">Accepted</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

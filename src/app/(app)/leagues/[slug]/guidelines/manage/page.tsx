import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArchiveGuidelineButton,
  GuidelineDraftForm,
  PublishGuidelineButton,
} from '@/components/guidelines';
import { requireLeagueAdminPage } from '@/lib/auth/page-guards';
import {
  getGuidelineAcceptanceStatus,
  getLeagueGuidelineVersions,
} from '@/lib/guidelines/guidelines';

export const metadata: Metadata = { title: 'Manage guidelines' };

export default async function ManageGuidelinesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { league } = await requireLeagueAdminPage(slug);

  const [versions, acceptance] = await Promise.all([
    getLeagueGuidelineVersions(league.id),
    getGuidelineAcceptanceStatus(league.id),
  ]);

  const drafts = versions.filter((version) => version.published_at === null);
  const published = versions.filter((version) => version.published_at !== null);
  const outstanding = acceptance.filter(
    (row) => !row.accepted && row.membership_status === 'active',
  );

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-muted">{league.name}</p>
        <h1 className="text-2xl font-bold">Guideline versions</h1>
        <Link
          href={`/leagues/${league.slug}/guidelines`}
          className="mt-1 text-sm font-semibold underline underline-offset-4"
        >
          View as a member
        </Link>
      </header>

      <section className="surface-card flex flex-col gap-3 p-4">
        <h2 className="text-base font-semibold">Acceptance status</h2>
        {acceptance.length === 0 ? (
          <p className="text-sm text-muted">No members yet.</p>
        ) : outstanding.length === 0 ? (
          <p className="text-sm text-muted">
            Every active member has accepted the current guidelines.
          </p>
        ) : (
          <p className="text-sm">
            <strong>{outstanding.length}</strong> of {acceptance.length} members have not yet
            accepted the current required version. They cannot sign up for matches in this league
            until they do.
          </p>
        )}
      </section>

      {drafts.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">Drafts</h2>
          {drafts.map((version) => (
            <div key={version.id} className="surface-card flex flex-col gap-3 p-4">
              <GuidelineDraftForm leagueId={league.id} version={version} />
              <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
                <PublishGuidelineButton leagueId={league.id} versionId={version.id} />
                <p className="text-xs text-muted">
                  Publishing freezes this text and notifies every active member once.
                </p>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <section className="surface-card flex flex-col gap-3 p-4">
        <h2 className="text-base font-semibold">New draft</h2>
        <GuidelineDraftForm leagueId={league.id} />
      </section>

      {published.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">Published</h2>
          <ul className="flex flex-col gap-2">
            {published.map((version) => (
              <li key={version.id} className="surface-card flex items-start justify-between gap-3 p-3">
                <div>
                  <p className="text-sm font-semibold">{version.title}</p>
                  <p className="text-xs text-muted">
                    {version.version_label}
                    {version.requires_acceptance ? ' · acceptance required' : ' · informational'}
                    {version.archived_at === null ? '' : ' · archived'}
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-muted">
                    checksum {version.content_checksum.slice(0, 16)}…
                  </p>
                </div>
                {version.archived_at === null ? (
                  <ArchiveGuidelineButton leagueId={league.id} versionId={version.id} />
                ) : null}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">
            Published text cannot be edited — members accepted that exact wording. Publish a new
            version instead.
          </p>
        </section>
      ) : null}
    </>
  );
}

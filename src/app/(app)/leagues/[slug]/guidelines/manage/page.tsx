import type { Metadata } from 'next';
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
import { ClipboardIcon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';
import { pluralWord } from '@/lib/format/plural';

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
      <PageHeader
        eyebrow={league.name}
        icon={<ClipboardIcon size={13} />}
        title="Guideline versions"
        description="Publish what this league asks of its players. A new version asks everybody to accept again."
        back={{ href: `/leagues/${league.slug}/guidelines`, label: 'View as a member' }}
      />

      <section className="surface-card flex flex-col gap-3 p-4">
        <h2 className="text-[0.9375rem] font-semibold">Acceptance status</h2>
        {acceptance.length === 0 ? (
          <p className="text-sm text-muted">No members yet.</p>
        ) : outstanding.length === 0 ? (
          <p className="text-sm text-muted">
            Every active member has accepted the current guidelines.
          </p>
        ) : (
          // The verb agrees with the *outstanding* count, which is the subject
          // of the sentence — "1 of 3 members has not yet accepted".
          <p className="text-sm">
            <strong>{outstanding.length}</strong> of {acceptance.length}{' '}
            {pluralWord(acceptance.length, 'member')}{' '}
            {outstanding.length === 1 ? 'has' : 'have'} not yet accepted the current required
            version. They cannot sign up for matches in this league until they do.
          </p>
        )}
      </section>

      {drafts.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-[0.9375rem] font-semibold">Drafts</h2>
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
        <h2 className="text-[0.9375rem] font-semibold">New draft</h2>
        <GuidelineDraftForm leagueId={league.id} />
      </section>

      {published.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-[0.9375rem] font-semibold">Published</h2>
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

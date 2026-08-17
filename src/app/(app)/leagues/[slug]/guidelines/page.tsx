import type { Metadata } from 'next';
import { AcceptGuidelinesForm } from '@/components/guidelines';
import { requireLeagueMemberPage } from '@/lib/auth/page-guards';
import { getMemberGuidelineView } from '@/lib/guidelines/guidelines';
import { ButtonLink } from '@/components/ui/button';
import { CheckIcon, ClipboardIcon, PlusIcon, SettingsIcon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/status';

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
      <PageHeader
        eyebrow={league.name}
        icon={<ClipboardIcon size={13} />}
        title="Guidelines"
        description="What this league asks of the people who play in it."
        actions={
          isAdmin ? (
            <ButtonLink
              href={`/leagues/${league.slug}/guidelines/manage`}
              icon={<SettingsIcon size={16} />}
            >
              Manage guideline versions
            </ButtonLink>
          ) : undefined
        }
      />

      {view.required === null ? (
        <EmptyState
          icon={<ClipboardIcon size={22} />}
          title="Nothing to accept"
          description={
            isAdmin
              ? 'This league has not published any guidelines that require acceptance. Publish a version and every active member is asked to agree to it once.'
              : 'This league does not currently ask you to accept any guidelines. If that changes you will get a notification.'
          }
          action={
            isAdmin ? (
              <ButtonLink
                href={`/leagues/${league.slug}/guidelines/manage`}
                variant="primary"
                icon={<PlusIcon size={17} />}
              >
                Write the first version
              </ButtonLink>
            ) : undefined
          }
        />
      ) : view.accepted ? (
        // Still a heading, not an EmptyState: this is a *state*, not an absence,
        // and the end-to-end suite navigates to it by heading.
        <section className="surface-card flex items-start gap-3 p-4">
          <span
            aria-hidden="true"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-pitch-50 text-pitch-600 dark:bg-pitch-900/50 dark:text-pitch-300"
          >
            <CheckIcon size={19} />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-[0.9375rem] font-semibold">You are up to date</h2>
            <p className="text-sm leading-relaxed text-secondary">
              You accepted <strong>{view.required.version_label}</strong>. If the league publishes a
              new version you will be asked again.
            </p>
          </div>
        </section>
      ) : (
        <section className="surface-card flex flex-col gap-4 p-4">
          <div>
            <h2 className="text-[0.9375rem] font-semibold">Acceptance needed</h2>
            <p className="mt-1 text-sm text-muted">
              You need to accept these guidelines before you can sign up for matches in this
              league. This does not affect any other league you belong to.
            </p>
          </div>

          <article className="whitespace-pre-wrap rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3 text-sm">
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
          <h2 className="text-[0.9375rem] font-semibold">All published versions</h2>
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

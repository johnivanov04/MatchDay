'use client';

import { useActionState } from 'react';
import { Field, FormError, inputClassName, SubmitButton } from '@/components/ui/field';
import {
  acceptGuidelineVersionAction,
  archiveGuidelineVersionAction,
  createGuidelineDraftAction,
  publishGuidelineVersionAction,
  updateGuidelineDraftAction,
} from '@/server/actions/guidelines';
import type { GuidelineVersionRow } from '@/types/database';

/**
 * The acceptance control.
 *
 * The checkbox starts unticked and is never pre-filled — 02 §8 requires
 * acceptance to be explicit and never prechecked — and an unticked box submits
 * nothing, which the schema treats as a refusal rather than a default. The text
 * being accepted is on the same page, above this control.
 */
export function AcceptGuidelinesForm({ version }: { version: GuidelineVersionRow }) {
  const [state, submit, pending] = useActionState(acceptGuidelineVersionAction, null);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="guideline_version_id" value={version.id} />
      <FormError message={state?.ok === false ? state.message : undefined} />

      <label className="flex items-start gap-2.5 text-sm">
        <input type="checkbox" name="confirm" value="accept" className="mt-0.5 size-4" />
        <span>
          I have read and accept <strong>{version.title}</strong> ({version.version_label}).
        </span>
      </label>
      {state?.ok === false && state.fieldErrors['confirm'] !== undefined ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.fieldErrors['confirm']}
        </p>
      ) : null}

      <SubmitButton pending={pending}>Accept guidelines</SubmitButton>
      <p className="text-xs text-muted">
        Acceptance is permanent and cannot be withdrawn. A future version will ask again.
      </p>
    </form>
  );
}

export function GuidelineDraftForm({
  leagueId,
  version,
}: {
  leagueId: string;
  version?: GuidelineVersionRow;
}) {
  const [state, submit, pending] = useActionState(
    version === undefined ? createGuidelineDraftAction : updateGuidelineDraftAction,
    null,
  );

  const fieldError = (name: string): string | undefined =>
    state?.ok === false ? state.fieldErrors[name] : undefined;

  return (
    <form action={submit} className="flex flex-col gap-4">
      <input type="hidden" name="league_id" value={leagueId} />
      {version === undefined ? null : (
        <input type="hidden" name="version_id" value={version.id} />
      )}

      <FormError message={state?.ok === false ? state.message : undefined} />
      {state?.ok === true ? (
        <p role="status" className="text-sm font-medium text-pitch-600">
          Draft saved.
        </p>
      ) : null}

      <Field
        label="Version label"
        htmlFor="version_label"
        hint="How you refer to this revision, e.g. 2026-spring."
        error={fieldError('version_label')}
      >
        <input
          id="version_label"
          name="version_label"
          required
          maxLength={60}
          defaultValue={version?.version_label ?? ''}
          className={inputClassName}
        />
      </Field>

      <Field label="Title" htmlFor="title" error={fieldError('title')}>
        <input
          id="title"
          name="title"
          required
          maxLength={160}
          defaultValue={version?.title ?? ''}
          className={inputClassName}
        />
      </Field>

      <Field label="Guidelines" htmlFor="body" error={fieldError('body')}>
        <textarea
          id="body"
          name="body"
          required
          rows={12}
          defaultValue={version?.body ?? ''}
          className={inputClassName}
        />
      </Field>

      <Field
        label="Document link"
        htmlFor="document_url"
        optional
        hint="An https:// link to a fuller document, if you keep one elsewhere."
        error={fieldError('document_url')}
      >
        <input
          id="document_url"
          name="document_url"
          type="url"
          defaultValue={version?.document_url ?? ''}
          className={inputClassName}
        />
      </Field>

      <Field label="Effective from" htmlFor="effective_at" optional error={fieldError('effective_at')}>
        <input
          id="effective_at"
          name="effective_at"
          type="date"
          defaultValue={version?.effective_at?.slice(0, 10) ?? ''}
          className={inputClassName}
        />
      </Field>

      <label className="flex items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          name="requires_acceptance"
          defaultChecked={version?.requires_acceptance ?? true}
          className="mt-0.5 size-4"
        />
        <span>
          Members must accept this version before they can sign up for matches.
          <span className="block text-xs text-muted">
            Publishing a version that requires acceptance immediately blocks signup in this league
            — and only this league — until each member accepts it.
          </span>
        </span>
      </label>

      <SubmitButton pending={pending}>
        {version === undefined ? 'Save draft' : 'Save changes'}
      </SubmitButton>
    </form>
  );
}

export function PublishGuidelineButton({
  leagueId,
  versionId,
}: {
  leagueId: string;
  versionId: string;
}) {
  const [state, submit, pending] = useActionState(publishGuidelineVersionAction, null);

  return (
    <form action={submit} className="inline">
      <input type="hidden" name="league_id" value={leagueId} />
      <input type="hidden" name="version_id" value={versionId} />
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 rounded-lg bg-pitch-600 px-3 py-2 text-sm font-semibold text-white hover:bg-pitch-700 disabled:opacity-60"
      >
        {pending ? 'Publishing…' : 'Publish'}
      </button>
      {state?.ok === false ? (
        <span role="alert" className="ml-2 text-sm text-red-600 dark:text-red-400">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

export function ArchiveGuidelineButton({
  leagueId,
  versionId,
}: {
  leagueId: string;
  versionId: string;
}) {
  const [state, submit, pending] = useActionState(archiveGuidelineVersionAction, null);

  return (
    <form action={submit} className="inline">
      <input type="hidden" name="league_id" value={leagueId} />
      <input type="hidden" name="version_id" value={versionId} />
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm font-semibold disabled:opacity-60"
      >
        {pending ? 'Archiving…' : 'Archive'}
      </button>
      {state?.ok === false ? (
        <span role="alert" className="ml-2 text-sm text-red-600 dark:text-red-400">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/field';
import { submitContentReportAction } from '@/server/actions/safety';
import type { ReportReason, ReportTargetType } from '@/types/database';

/**
 * Reporting something to the people who run MatchDay.
 *
 * ── WHY A REASON LIST AND AN OPTIONAL BOX ──────────────────────────────────
 *
 * A required free-text field is a reason not to report: somebody who is being
 * harassed does not want to compose an essay about it, and the category is
 * usually the whole story. So the category is the report, and the box is there
 * for the cases where it genuinely is not.
 *
 * ── THE CONFIRMATION SAYS WHAT WILL HAPPEN, NOT "THANKS" ───────────────────
 *
 * It tells somebody a human will look and that the person reported is not told
 * who reported them — which is the thing they are actually worried about when
 * they press the button, and the reason people do not report in apps that stay
 * silent about it.
 */

const REASON_LABELS: ReadonlyArray<{ value: ReportReason; label: string }> = [
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'hate_speech', label: 'Hate speech or discrimination' },
  { value: 'sexual_content', label: 'Sexual or explicit content' },
  { value: 'violence_or_threats', label: 'Violence or threats' },
  { value: 'spam', label: 'Spam or scam' },
  { value: 'impersonation', label: 'Impersonation' },
  { value: 'other', label: 'Something else' },
];

const TARGET_NOUN: Record<ReportTargetType, string> = {
  user: 'this member',
  league: 'this league',
  match: 'this match',
  guideline: 'these guidelines',
};

export function ReportContent({
  targetType,
  targetId,
  label,
}: {
  targetType: ReportTargetType;
  targetId: string;
  /** Overrides the default trigger wording where a surface needs to be specific. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, submit, pending] = useActionState(submitContentReportAction, null);

  if (state?.ok === true) {
    return (
      <p role="status" className="text-xs text-muted">
        Reported. Somebody will review this. The member you reported is not told who reported
        them.
      </p>
    );
  }

  if (!open) {
    return (
      <Button type="button" variant="ghost" onClick={() => setOpen(true)}>
        {label ?? `Report ${TARGET_NOUN[targetType]}`}
      </Button>
    );
  }

  return (
    <form action={submit} className="space-y-2 rounded-[var(--radius-md)] border border-line p-3">
      <input type="hidden" name="target_type" value={targetType} />
      <input type="hidden" name="target_id" value={targetId} />

      <fieldset>
        <legend className="text-sm font-medium">Why are you reporting {TARGET_NOUN[targetType]}?</legend>
        <div className="mt-2 space-y-1">
          {REASON_LABELS.map((reason) => (
            <label key={reason.value} className="flex items-center gap-2 text-sm">
              <input type="radio" name="reason" value={reason.value} required />
              {reason.label}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block text-sm">
        <span className="text-muted">Anything else? (optional)</span>
        <textarea
          name="details"
          rows={3}
          maxLength={1000}
          className="mt-1 w-full rounded-[var(--radius-sm)] border border-line p-2 text-sm"
        />
      </label>

      {state?.ok === false ? (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      ) : null}

      <div className="flex gap-2">
        <SubmitButton pending={pending}>
          Send report
        </SubmitButton>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

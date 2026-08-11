import type { MatchLifecycleStatus } from '@/types/database';

/**
 * Who may edit a match, and which form they get.
 *
 * Extracted from the pages so the rule is one testable function rather than a
 * conditional repeated in two places — the detail page decides whether to show
 * the button, the edit route decides whether to serve the form, and they must
 * not be able to disagree.
 *
 * This is presentation and routing only. It is never the thing that stops an
 * edit: `update_draft_match()` and `update_published_match()` each re-check
 * administration from `auth.uid()`, and Row Level Security refuses the rows
 * independently of both.
 */

export type MatchEditMode = 'draft' | 'published';

/**
 * Only a draft or an open match can be edited.
 *
 * Canceled matches are read-only in this phase, and the remaining lifecycle
 * states are not implemented at all — a match cannot reach them, and offering a
 * form for one would promise something no code understands.
 */
export function matchEditMode(status: MatchLifecycleStatus): MatchEditMode | null {
  if (status === 'draft') return 'draft';
  if (status === 'open') return 'published';
  return null;
}

/** True when this viewer should be offered the edit control at all. */
export function canEditMatch(isAdmin: boolean, status: MatchLifecycleStatus): boolean {
  return isAdmin && matchEditMode(status) !== null;
}

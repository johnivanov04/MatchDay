'use client';

import { useActionState } from 'react';
import { ReportContent } from '@/components/report-content';
import { SubmitButton } from '@/components/ui/field';
import { blockUserAction, unblockUserAction } from '@/server/actions/safety';

/**
 * What one member can do about another.
 *
 * Report and block are deliberately adjacent: they answer different questions —
 * "somebody should look at this" and "I do not want to see this person" — and
 * somebody in the moment of needing one usually wants the other too.
 *
 * ── BLOCKING IS NOT LEAVING THE LEAGUE ─────────────────────────────────────
 *
 * The copy says what actually happens, because the honest answer is partial:
 * MatchDay has no messaging, so a block hides a name and stops a join request.
 * It cannot remove somebody from a match you both signed up for, and promising
 * otherwise would be the kind of safety theatre that gets somebody hurt.
 */

export function MemberSafety({
  userId,
  isBlocked,
  compact = false,
}: {
  userId: string;
  isBlocked: boolean;
  /**
   * Inside a roster row rather than on its own. A twenty-player roster cannot
   * carry twenty paragraphs of explanation, so the explanatory copy moves to
   * /settings/blocked and the controls stay.
   */
  compact?: boolean;
}) {
  const [blockState, block, blockPending] = useActionState(blockUserAction, null);
  const [unblockState, unblock, unblockPending] = useActionState(unblockUserAction, null);
  const state = blockState ?? unblockState;

  return (
    <div className={compact ? 'flex shrink-0 items-center gap-1' : 'space-y-2'}>
      <ReportContent targetType="user" targetId={userId} label="Report this member" />

      <form action={isBlocked ? unblock : block}>
        <input type="hidden" name="user_id" value={userId} />
        <SubmitButton variant="secondary" block={false} pending={blockPending || unblockPending}>
          {isBlocked ? 'Unblock this member' : 'Block this member'}
        </SubmitButton>
      </form>

      {isBlocked && !compact ? (
        <p className="text-xs text-muted">
          You will not see this member&rsquo;s name on rosters or team sheets, and neither of you
          can send the other a request to join a league.
        </p>
      ) : null}

      {state?.ok === false ? (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

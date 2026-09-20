'use client';

import { useActionState } from 'react';
import { SubmitButton } from '@/components/ui/field';
import { unblockUserAction } from '@/server/actions/safety';
import type { BlockedMemberRow } from '@/types/database';

function Row({ member }: { member: BlockedMemberRow }) {
  const [state, unblock, pending] = useActionState(unblockUserAction, null);

  return (
    <li className="flex items-center justify-between gap-3 border-b border-line py-2 last:border-0">
      <div>
        <p className="text-sm font-medium">
          {member.first_name} {member.last_name}
        </p>
        <p className="text-xs text-muted">
          Blocked {new Date(member.blocked_at).toLocaleDateString()}
        </p>
        {state?.ok === false ? (
          <p role="alert" className="text-sm text-danger">
            {state.message}
          </p>
        ) : null}
      </div>
      <form action={unblock}>
        <input type="hidden" name="user_id" value={member.user_id} />
        <SubmitButton variant="secondary" block={false} pending={pending}>
          Unblock
        </SubmitButton>
      </form>
    </li>
  );
}

export function BlockedMembers({ members }: { members: readonly BlockedMemberRow[] }) {
  return (
    <ul>
      {members.map((member) => (
        <Row key={member.user_id} member={member} />
      ))}
    </ul>
  );
}

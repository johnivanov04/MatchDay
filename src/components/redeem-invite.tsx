'use client';

import { useActionState } from 'react';
import { Button, ButtonLink } from '@/components/ui/button';
import { redeemInviteAction } from '@/server/actions/invites';

/**
 * Invitation redemption.
 *
 * The token is only ever submitted, never displayed. Nothing about the league
 * is shown before redemption succeeds: rendering the name first would let
 * anyone holding a guessed token confirm that a private league exists.
 */
export function RedeemInviteForm({ token }: { token: string }) {
  const [state, submit, pending] = useActionState(redeemInviteAction, null);

  if (state?.ok === true) {
    return (
      <div className="surface-card flex flex-col gap-3 p-4">
        <h2 className="text-[0.9375rem] font-semibold">
          {state.data.joined ? 'You are in.' : 'You already belong to this league.'}
        </h2>
        <p className="text-sm text-muted">
          {state.data.status === 'pending'
            ? 'The administrator needs to approve your membership before you can take part.'
            : 'Your membership is active.'}
        </p>
        <ButtonLink href="/dashboard" variant="primary">
          Go to your dashboard
        </ButtonLink>
      </div>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />

      {state?.ok === false ? (
        <p
          role="alert"
          className="rounded-lg border border-whistle-200 bg-whistle-50 px-3 py-2 text-sm text-red-800 dark:border-whistle-900 dark:bg-whistle-900/25 dark:text-red-200"
        >
          {state.message}
        </p>
      ) : null}

      <Button type="submit" variant="primary" disabled={pending} aria-busy={pending}>
        {pending ? 'Joining…' : 'Accept invitation'}
      </Button>
    </form>
  );
}

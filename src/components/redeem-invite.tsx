'use client';

import { useActionState } from 'react';
import Link from 'next/link';
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
        <h2 className="text-base font-semibold">
          {state.data.joined ? 'You are in.' : 'You already belong to this league.'}
        </h2>
        <p className="text-sm text-muted">
          {state.data.status === 'pending'
            ? 'The administrator needs to approve your membership before you can take part.'
            : 'Your membership is active.'}
        </p>
        <Link
          href="/dashboard"
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-pitch-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-pitch-700"
        >
          Go to your dashboard
        </Link>
      </div>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />

      {state?.ok === false ? (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200"
        >
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-11 items-center justify-center rounded-lg bg-pitch-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-pitch-700 disabled:opacity-60"
      >
        {pending ? 'Joining…' : 'Accept invitation'}
      </button>
    </form>
  );
}

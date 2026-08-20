'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SubmitButton } from '@/components/ui/field';
import { Notice } from '@/components/ui/status';
import { retryAccountDeletionAction } from '@/server/actions/account';

/**
 * The only screen an account whose deletion has begun can reach.
 *
 * ── WHY THE PENDING STATE IS NOT HIDDEN ────────────────────────────────────
 *
 * It would be easy to tell everybody "your account has been deleted" and let
 * the reconciler tidy up. That would be a lie in one specific and important
 * case: when Postgres has been scrubbed but the Auth row survives, MatchDay
 * looks anonymous while `auth.users` still holds the person's real email
 * address. They are entitled to know it is not finished, and to finish it
 * themselves rather than wait for a job they cannot see.
 *
 * So the two unfinished states are told apart plainly, and both offer the same
 * one-press way forward.
 */
export type DeletionState =
  /** No session at all: the deletion completed and signed them out. */
  | 'signed-out'
  /** `deletion_started_at` set, scrub not yet committed. */
  | 'pending'
  /** Scrubbed, but the Auth identity outlived it. */
  | 'scrubbed';

export function AccountDeletionStatus({
  state,
  signInPath = '/sign-in',
}: {
  state: DeletionState;
  signInPath?: string;
}) {
  const [result, retry, retrying] = useActionState(retryAccountDeletionAction, null);

  if (state === 'signed-out') {
    return (
      <Card className="animate-rise flex flex-col gap-4 p-5">
        <h1 className="text-[1.5rem] font-bold leading-tight">Your account was deleted</h1>
        <p className="text-sm leading-relaxed text-secondary">
          Your MatchDay account and personal details have been removed. Matches you played in are
          still recorded for the leagues you were part of, but they no longer carry your name or
          photo.
        </p>
        <p className="text-sm leading-relaxed text-secondary">
          You are welcome back any time — signing up again with the same email address creates a
          brand-new account.
        </p>
        <Link href={signInPath} className="self-start">
          <Button variant="secondary">Back to sign in</Button>
        </Link>
      </Card>
    );
  }

  return (
    <Card className="animate-rise flex flex-col gap-4 p-5">
      <h1 className="text-[1.5rem] font-bold leading-tight">
        {state === 'pending' ? 'Finishing your account deletion' : 'Almost finished'}
      </h1>

      <p className="text-sm leading-relaxed text-secondary">
        {state === 'pending'
          ? 'Your account is being deleted. It can no longer be used, and nobody in your leagues can see your name or photo any more — but one step has not finished yet.'
          : 'Your MatchDay details have been removed and nobody can see your name or photo. Your sign-in details have not finished being deleted yet.'}
      </p>

      {/* The honest sentence. Somebody in this state has been told their account
          is going; they should not also be told it is gone when it is not. */}
      <Notice tone="warning">
        This usually completes on its own within the hour. You can also finish it now.
      </Notice>

      {result?.ok === false ? (
        <p role="alert" className="text-sm font-medium text-whistle-600 dark:text-whistle-300">
          {result.message}
        </p>
      ) : null}

      <form action={retry} className="flex flex-col gap-3">
        <SubmitButton pending={retrying}>
          {retrying ? 'Finishing…' : 'Finish deleting account'}
        </SubmitButton>
      </form>

      {/* Sign out is the only other thing on this page, and it does not undo
          anything: the account stays in exactly this state and the reconciler
          still finishes it. */}
      <form action="/auth/sign-out" method="post">
        <Button type="submit" variant="ghost" block>
          Sign out
        </Button>
      </form>
    </Card>
  );
}

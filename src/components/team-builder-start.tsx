'use client';

import { useActionState } from 'react';
import { FormError, SubmitButton } from '@/components/ui/field';
import { ensureMatchTeamsAction } from '@/server/actions/teams';

/**
 * Creates the match's configured teams.
 *
 * Deliberately a button rather than something the page does while rendering: a
 * GET must not have side effects, and an administrator opening the builder to
 * look should not silently write rows.
 */
export function StartTeamsButton({
  leagueId,
  matchId,
}: {
  leagueId: string;
  matchId: string;
}) {
  const [state, submit, pending] = useActionState(ensureMatchTeamsAction, null);

  return (
    <form action={submit} className="mt-3 flex flex-col gap-2">
      <input type="hidden" name="league_id" value={leagueId} />
      <input type="hidden" name="match_id" value={matchId} />
      <FormError message={state?.ok === false ? state.message : undefined} />
      <SubmitButton pending={pending}>Set up teams</SubmitButton>
    </form>
  );
}

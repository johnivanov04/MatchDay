'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { actionFailure, actionSuccess, DomainError, type ActionResult } from '@/lib/errors';
import { setActiveLeague } from '@/lib/leagues/active-league';

const leagueIdSchema = z.uuid({ message: 'Choose a league from the list.' });

/**
 * Switches the league the user is currently working in.
 *
 * The submitted league ID is untrusted input. `setActiveLeague` re-derives the
 * user from the session and confirms an active membership before writing, and
 * the database repeats that check in a trigger. Selecting a league also grants
 * nothing on its own: no RLS policy consults the active league.
 */
export async function switchActiveLeagueAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const parsed = leagueIdSchema.safeParse(formData.get('league_id') ?? '');

    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', {
        fieldErrors: { league_id: 'Choose a league from the list.' },
      });
    }

    await setActiveLeague(parsed.data);

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

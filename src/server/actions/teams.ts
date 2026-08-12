'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireLeagueAdmin } from '@/lib/auth/authorization';
import { actionFailure, actionSuccess, type ActionResult } from '@/lib/errors';
import { domainErrorFromDatabase } from '@/lib/errors-from-database';
import { dispatchPushForKeyPrefix } from '@/lib/push/notify';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Phase 6 team-builder actions.
 *
 * Each is a thin shell around a database function that owns the whole
 * transaction — the match row lock, the confirmation re-check, the audit event
 * and, for publication, the snapshot and the notifications. None of them
 * computes an outcome, and none passes an actor, a league or a confirmation
 * status: the database derives all of that from `auth.uid()`.
 *
 * `requireLeagueAdmin` runs first so an obvious refusal never reaches the
 * database, but it is not the security boundary — every function re-checks
 * administration itself and Row Level Security refuses the rows independently.
 */

const matchIdSchema = z.uuid();
const teamIdSchema = z.uuid();

/**
 * Pushes a fanout the database has already committed.
 *
 * After the transaction and outside the `try` that decides the result, for the
 * reason the match and signup actions give: the teams are published and the
 * canonical notifications exist, so a push that does not go out must never come
 * back to the administrator as a failed publication.
 */
async function pushCommittedFanout(prefix: string): Promise<void> {
  try {
    await dispatchPushForKeyPrefix(prefix);
  } catch {
    /* deliberately silent — the notification is already safe in the inbox */
  }
}

/** Shape shared by every builder mutation that returns nothing interesting. */
async function teamMutation(
  leagueId: string,
  // `PromiseLike`, not `Promise`: supabase-js returns a thenable query builder
  // rather than a real promise, and awaiting it is what resolves it.
  run: (
    supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  ) => PromiseLike<{ error: unknown }>,
): Promise<ActionResult<undefined>> {
  try {
    await requireLeagueAdmin(z.uuid().parse(leagueId));

    const supabase = await createSupabaseServerClient();
    const { error } = await run(supabase);

    if (error !== null) {
      throw domainErrorFromDatabase(error as { message?: unknown; code?: unknown });
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/**
 * Creates the match's configured number of teams, if none exist yet.
 *
 * Idempotent, so the builder can call it on every load without accumulating
 * teams. The count comes from `matches.team_count`; nothing here assumes two.
 */
export async function ensureMatchTeamsAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  const leagueId = String(formData.get('league_id') ?? '');
  const matchId = matchIdSchema.parse(formData.get('match_id') ?? '');

  return teamMutation(leagueId, (supabase) =>
    supabase.rpc('ensure_match_teams', { p_match_id: matchId }),
  );
}

export async function createTeamAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  const leagueId = String(formData.get('league_id') ?? '');
  const matchId = matchIdSchema.parse(formData.get('match_id') ?? '');

  return teamMutation(leagueId, (supabase) =>
    supabase.rpc('create_match_team', {
      p_match_id: matchId,
      p_name: null,
      p_label: null,
    }),
  );
}

export async function renameTeamAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  const leagueId = String(formData.get('league_id') ?? '');
  const teamId = teamIdSchema.parse(formData.get('team_id') ?? '');
  const name = z.string().min(1).max(60).parse(formData.get('name') ?? '');
  const rawLabel = formData.get('label');
  const label =
    typeof rawLabel === 'string' && rawLabel.trim() !== ''
      ? z.string().max(40).parse(rawLabel.trim())
      : null;

  return teamMutation(leagueId, (supabase) =>
    supabase.rpc('rename_match_team', { p_team_id: teamId, p_name: name, p_label: label }),
  );
}

/**
 * Deletes a draft team.
 *
 * Its players become unassigned rather than being moved somewhere — silently
 * relocating people is the one outcome an administrator cannot spot by looking
 * at the screen. The published snapshot is untouched.
 */
export async function deleteTeamAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  const leagueId = String(formData.get('league_id') ?? '');
  const teamId = teamIdSchema.parse(formData.get('team_id') ?? '');

  return teamMutation(leagueId, (supabase) =>
    supabase.rpc('delete_match_team', { p_team_id: teamId }),
  );
}

/**
 * Assigns a player, or moves them between teams.
 *
 * One action for both: they differ only in whether a row already exists, and
 * the unique constraint on `(match_id, membership_id)` is what makes the second
 * one a move rather than a duplicate.
 */
export async function assignPlayerAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  const leagueId = String(formData.get('league_id') ?? '');
  const membershipId = z.uuid().parse(formData.get('membership_id') ?? '');
  const rawTeam = formData.get('team_id');
  const matchId = matchIdSchema.parse(formData.get('match_id') ?? '');

  // An empty team means "unassign", which is a different function rather than
  // an assignment to nowhere.
  if (typeof rawTeam !== 'string' || rawTeam === '') {
    return teamMutation(leagueId, (supabase) =>
      supabase.rpc('unassign_player_from_team', {
        p_match_id: matchId,
        p_membership_id: membershipId,
      }),
    );
  }

  const teamId = teamIdSchema.parse(rawTeam);
  return teamMutation(leagueId, (supabase) =>
    supabase.rpc('assign_player_to_team', {
      p_team_id: teamId,
      p_membership_id: membershipId,
    }),
  );
}

/**
 * Randomizes the draft.
 *
 * Count only — see `randomize_match_teams()`. Nothing about position,
 * goalkeeper willingness, gender or history reaches the database, because the
 * action sends only the match id and the function reads none of it.
 */
export async function randomizeTeamsAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  const leagueId = String(formData.get('league_id') ?? '');
  const matchId = matchIdSchema.parse(formData.get('match_id') ?? '');

  return teamMutation(leagueId, (supabase) =>
    supabase.rpc('randomize_match_teams', { p_match_id: matchId }),
  );
}

/**
 * Publishes the draft.
 *
 * The one moment players are told anything. The database validates that every
 * confirmed player is on a team, writes the snapshot and the notifications in
 * one transaction, and returns the revision — which the push prefix then uses,
 * so the dispatch matches exactly the batch just created.
 */
export async function publishTeamsAction(
  _previous: ActionResult<number> | null,
  formData: FormData,
): Promise<ActionResult<number>> {
  let matchId: string;
  let revision: number;

  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    matchId = matchIdSchema.parse(formData.get('match_id') ?? '');

    await requireLeagueAdmin(leagueId);

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc('publish_match_teams', { p_match_id: matchId });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revision = data ?? 0;
  } catch (error: unknown) {
    return actionFailure(error);
  }

  await pushCommittedFanout(`teams:${matchId}:${String(revision)}`);

  revalidatePath('/', 'layout');
  return actionSuccess(revision);
}

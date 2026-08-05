'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireLeagueAdmin } from '@/lib/auth/authorization';
import { requireSessionUser } from '@/lib/auth/session';
import { actionFailure, actionSuccess, DomainError, type ActionResult } from '@/lib/errors';
import { domainErrorFromDatabase } from '@/lib/errors-from-database';
import { dispatchPushForKeyPrefix } from '@/lib/push/notify';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  createMatchSchema,
  hoursToInterval,
  matchTemplateSchema,
  updatePublishedMatchSchema,
} from '@/lib/validation/match';
import { toFieldErrors } from '@/lib/validation/profile';

function readTemplateForm(formData: FormData) {
  return {
    name: formData.get('name') ?? '',
    day_of_week: formData.get('day_of_week') ?? '',
    recurrence_note: formData.get('recurrence_note') ?? '',
    arrival_time: formData.get('arrival_time') ?? '',
    kickoff_time: formData.get('kickoff_time') ?? '',
    end_time: formData.get('end_time') ?? '',
    location_name: formData.get('location_name') ?? '',
    location_map_url: formData.get('location_map_url') ?? '',
    capacity: formData.get('capacity') ?? '',
    min_players: formData.get('min_players') ?? '0',
    team_count: formData.get('team_count') ?? '2',
    selection_mode: formData.get('selection_mode') ?? 'first_come',
    waitlist_mode: formData.get('waitlist_mode') ?? 'automatic',
    priority_window_hours: formData.get('priority_window_hours') ?? '',
    signup_closes_before_hours: formData.get('signup_closes_before_hours') ?? '2',
    cancellation_cutoff_before_hours: formData.get('cancellation_cutoff_before_hours') ?? '24',
    roster_publish_before_hours: formData.get('roster_publish_before_hours') ?? '',
    is_active: formData.get('is_active') !== 'off',
  };
}

export async function saveMatchTemplateAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    await requireLeagueAdmin(leagueId);

    const rawTemplateId = formData.get('template_id');
    const templateId =
      typeof rawTemplateId === 'string' && rawTemplateId !== ''
        ? z.uuid().parse(rawTemplateId)
        : null;

    const parsed = matchTemplateSchema.safeParse(readTemplateForm(formData));
    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', { fieldErrors: toFieldErrors(parsed.error) });
    }

    const user = await requireSessionUser();
    const supabase = await createSupabaseServerClient();

    // `league_id` is deliberately absent from the update path: a template can
    // never be moved between tenants, and the type says so.
    const row = {
      name: parsed.data.name,
      day_of_week: parsed.data.day_of_week,
      recurrence_note: parsed.data.recurrence_note,
      arrival_time: parsed.data.arrival_time,
      kickoff_time: parsed.data.kickoff_time,
      end_time: parsed.data.end_time,
      location_name: parsed.data.location_name,
      location_map_url: parsed.data.location_map_url,
      capacity: parsed.data.capacity,
      min_players: parsed.data.min_players,
      team_count: parsed.data.team_count,
      selection_mode: parsed.data.selection_mode,
      waitlist_mode: parsed.data.waitlist_mode,
      priority_window: hoursToInterval(parsed.data.priority_window_hours),
      signup_closes_before: `${parsed.data.signup_closes_before_hours} hours`,
      cancellation_cutoff_before: `${parsed.data.cancellation_cutoff_before_hours} hours`,
      roster_publish_before: hoursToInterval(parsed.data.roster_publish_before_hours),
      reminder_offsets: [],
      is_active: parsed.data.is_active,
      created_by: user.id,
    };

    const { error } =
      templateId === null
        ? await supabase.from('match_templates').insert({ ...row, league_id: leagueId })
        : await supabase
            .from('match_templates')
            .update(row)
            .eq('id', templateId)
            .eq('league_id', leagueId);

    if (error !== null) {
      throw domainErrorFromDatabase(error, { VALIDATION_FAILED: 'name' });
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/**
 * Creates a match as a draft.
 *
 * Local times and relative deadline rules go to the database, which resolves
 * them against the league's own timezone. Doing that conversion here would put
 * a second daylight-saving implementation in the system.
 */
export async function createMatchAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  let slug: string;

  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    slug = z.string().min(1).parse(formData.get('league_slug') ?? '');
    await requireLeagueAdmin(leagueId);

    const parsed = createMatchSchema.safeParse({
      ...readTemplateForm(formData),
      name: 'unused',
      title: formData.get('title') ?? '',
      match_date: formData.get('match_date') ?? '',
      template_id: formData.get('template_id') ?? '',
      public_notes: formData.get('public_notes') ?? '',
      admin_notes: formData.get('admin_notes') ?? '',
    });

    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', { fieldErrors: toFieldErrors(parsed.error) });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('create_match', {
      p_league_id: leagueId,
      p_title: parsed.data.title,
      p_match_date: parsed.data.match_date,
      p_arrival_time: parsed.data.arrival_time,
      p_kickoff_time: parsed.data.kickoff_time,
      p_end_time: parsed.data.end_time,
      p_location_name: parsed.data.location_name,
      p_capacity: parsed.data.capacity,
      p_min_players: parsed.data.min_players,
      p_selection_mode: parsed.data.selection_mode,
      p_waitlist_mode: parsed.data.waitlist_mode,
      p_team_count: parsed.data.team_count,
      p_template_id: parsed.data.template_id,
      p_location_map_url: parsed.data.location_map_url,
      p_priority_window: hoursToInterval(parsed.data.priority_window_hours),
      p_signup_closes_before: `${parsed.data.signup_closes_before_hours} hours`,
      p_cancellation_cutoff_before: `${parsed.data.cancellation_cutoff_before_hours} hours`,
      p_roster_publish_before: hoursToInterval(parsed.data.roster_publish_before_hours),
      p_public_notes: parsed.data.public_notes,
      p_admin_notes: parsed.data.admin_notes,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }
  } catch (error: unknown) {
    return actionFailure(error);
  }

  revalidatePath('/', 'layout');
  redirect(`/leagues/${slug}/matches`);
}

/**
 * Publishes a match, then pushes.
 *
 * The RPC creates one canonical notification per active member and commits.
 * Only then is push attempted, and its outcome is never allowed to affect this
 * action's result — the match is published either way.
 */
export async function publishMatchAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    const matchId = z.uuid().parse(formData.get('match_id') ?? '');
    await requireLeagueAdmin(leagueId);

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('publish_match', { p_match_id: matchId });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    await dispatchPushForKeyPrefix(`match_published:${matchId}`);

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

export async function cancelMatchAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    const matchId = z.uuid().parse(formData.get('match_id') ?? '');
    await requireLeagueAdmin(leagueId);

    const reason = z
      .string()
      .max(500)
      .parse(typeof formData.get('reason') === 'string' ? String(formData.get('reason')) : '');

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('cancel_match', {
      p_match_id: matchId,
      p_reason: reason === '' ? null : reason,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    await dispatchPushForKeyPrefix(`match_canceled:${matchId}`);

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/**
 * The deliberate, audited edit path for a published match.
 *
 * A direct UPDATE is refused by `matches_update_draft_admin`, so this is the
 * only way an open match changes. It bumps the revision, writes an audit event
 * and notifies members — all in one transaction.
 */
export async function updatePublishedMatchAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    const matchId = z.uuid().parse(formData.get('match_id') ?? '');
    await requireLeagueAdmin(leagueId);

    const parsed = updatePublishedMatchSchema.safeParse({
      title: formData.get('title') ?? '',
      match_date: formData.get('match_date') ?? '',
      arrival_time: formData.get('arrival_time') ?? '',
      kickoff_time: formData.get('kickoff_time') ?? '',
      end_time: formData.get('end_time') ?? '',
      location_name: formData.get('location_name') ?? '',
      location_map_url: formData.get('location_map_url') ?? '',
      capacity: formData.get('capacity') ?? '',
      min_players: formData.get('min_players') ?? '0',
      team_count: formData.get('team_count') ?? '2',
      public_notes: formData.get('public_notes') ?? '',
      change_note: formData.get('change_note') ?? '',
    });

    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', { fieldErrors: toFieldErrors(parsed.error) });
    }

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc('update_published_match', {
      p_match_id: matchId,
      p_title: parsed.data.title,
      p_match_date: parsed.data.match_date,
      p_arrival_time: parsed.data.arrival_time,
      p_kickoff_time: parsed.data.kickoff_time,
      p_end_time: parsed.data.end_time,
      p_location_name: parsed.data.location_name,
      p_capacity: parsed.data.capacity,
      p_min_players: parsed.data.min_players,
      p_team_count: parsed.data.team_count,
      p_location_map_url: parsed.data.location_map_url,
      p_public_notes: parsed.data.public_notes,
      p_change_note: parsed.data.change_note,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    // The revision is part of the notification key, so pushing the right batch
    // means asking for the revision the database just produced.
    await dispatchPushForKeyPrefix(`match_changed:${matchId}:${String(data)}`);

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/** Draft-only edit of administrator notes. */
export async function saveMatchAdminNotesAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    const matchId = z.uuid().parse(formData.get('match_id') ?? '');
    await requireLeagueAdmin(leagueId);

    const notes = z.string().max(4000).parse(String(formData.get('notes') ?? '')).trim();

    const supabase = await createSupabaseServerClient();

    const { error } =
      notes === ''
        ? await supabase
            .from('match_admin_notes')
            .delete()
            .eq('match_id', matchId)
            .eq('league_id', leagueId)
        : await supabase
            .from('match_admin_notes')
            .upsert(
              { match_id: matchId, league_id: leagueId, notes },
              { onConflict: 'match_id' },
            );

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

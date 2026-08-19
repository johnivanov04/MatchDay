'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireLeagueAdmin } from '@/lib/auth/authorization';
import { requireSessionUser } from '@/lib/auth/session';
import { actionFailure, actionSuccess, DomainError, type ActionResult } from '@/lib/errors';
import { domainErrorFromDatabase } from '@/lib/errors-from-database';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  createLeagueSchema,
  leagueVisibilitySchema,
  updateLeagueSettingsSchema,
} from '@/lib/validation/league';
import { toFieldErrors } from '@/lib/validation/profile';

/**
 * League creation and settings.
 *
 * Every action below is an untrusted POST endpoint reachable without going
 * through the UI, so each one re-derives the actor from the session and
 * re-checks authorization. The client supplies *which* league and *what*
 * change; it never supplies who it is or what role it holds.
 */

function readCheckbox(formData: FormData, name: string): boolean {
  return formData.get(name) === 'on' || formData.get(name) === 'true';
}

function readLeagueFields(formData: FormData) {
  return {
    name: formData.get('name') ?? '',
    general_area: formData.get('general_area') ?? '',
    timezone: formData.get('timezone') ?? '',
    sport_label: formData.get('sport_label') ?? '',
    description: formData.get('description') ?? '',
    default_capacity: formData.get('default_capacity') ?? '',
    default_min_players: formData.get('default_min_players') ?? '0',
    default_selection_mode: formData.get('default_selection_mode') ?? 'first_come',
    default_waitlist_mode: formData.get('default_waitlist_mode') ?? 'automatic',
    default_team_count: formData.get('default_team_count') ?? '2',
    default_location: formData.get('default_location') ?? '',
    typical_schedule: formData.get('typical_schedule') ?? '',
    gender_field_enabled: readCheckbox(formData, 'gender_field_enabled'),
    goalkeeper_field_enabled: readCheckbox(formData, 'goalkeeper_field_enabled'),
    // Hours from the form; the schema turns them into interval literals. The
    // two required ones fall back to the same values the columns default to,
    // so a form posted without them behaves exactly as it did before these
    // fields existed.
    default_signup_closes_before: formData.get('default_signup_closes_before') ?? '2',
    default_cancellation_cutoff_before: formData.get('default_cancellation_cutoff_before') ?? '24',
    default_priority_window: formData.get('default_priority_window') ?? '',
    default_roster_publish_before: formData.get('default_roster_publish_before') ?? '',
  };
}

/**
 * Creates a league with the caller as its sole administrator.
 *
 * The whole operation is one `create_league()` call, and it has to be: the
 * league row and the administrator membership must reach COMMIT together or the
 * Phase 1 deferred constraint rejects the transaction. Doing this from the
 * application in two statements is not possible, which is the point.
 *
 * `visibility` is absent by design — new leagues are private (PRD §6) and the
 * function hard-codes it, so there is nothing here for a client to override.
 */
export async function createLeagueAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  let slug: string;

  try {
    await requireSessionUser();

    const parsed = createLeagueSchema.safeParse({
      ...readLeagueFields(formData),
      slug: formData.get('slug') ?? '',
    });

    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', { fieldErrors: toFieldErrors(parsed.error) });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('create_league', {
      p_name: parsed.data.name,
      p_slug: parsed.data.slug,
      p_general_area: parsed.data.general_area,
      p_timezone: parsed.data.timezone,
      p_sport_label: parsed.data.sport_label,
      p_description: parsed.data.description,
      p_default_capacity: parsed.data.default_capacity,
      p_default_min_players: parsed.data.default_min_players,
      p_default_selection_mode: parsed.data.default_selection_mode,
      p_default_waitlist_mode: parsed.data.default_waitlist_mode,
      p_default_team_count: parsed.data.default_team_count,
      p_default_location: parsed.data.default_location,
      p_typical_schedule: parsed.data.typical_schedule,
      p_gender_field_enabled: parsed.data.gender_field_enabled,
      p_goalkeeper_field_enabled: parsed.data.goalkeeper_field_enabled,
      p_default_signup_closes_before: parsed.data.default_signup_closes_before,
      p_default_cancellation_cutoff_before: parsed.data.default_cancellation_cutoff_before,
      p_default_priority_window: parsed.data.default_priority_window,
      p_default_roster_publish_before: parsed.data.default_roster_publish_before,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error, { SLUG_TAKEN: 'slug' });
    }

    slug = parsed.data.slug;
  } catch (error: unknown) {
    return actionFailure(error);
  }

  // Revalidate before redirecting: `redirect` throws, so anything after it in
  // the try block would never run.
  revalidatePath('/', 'layout');
  redirect(`/leagues/${slug}/settings`);
}

/** Updates league settings. Audited by the `leagues_audit_update` trigger, whatever the path. */
export async function updateLeagueSettingsAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    await requireLeagueAdmin(leagueId);

    const parsed = updateLeagueSettingsSchema.safeParse(readLeagueFields(formData));
    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', { fieldErrors: toFieldErrors(parsed.error) });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.from('leagues').update(parsed.data).eq('id', leagueId);

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/**
 * Switches a league between private and searchable.
 *
 * Kept separate from the settings form because it is the one setting that
 * changes who outside the league can see it exists, and because F-02 makes
 * "changing visibility creates an audit event" an explicit acceptance
 * criterion. The event is written by the database trigger, so it holds even for
 * a caller that bypasses this action entirely.
 */
export async function setLeagueVisibilityAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    const visibility = leagueVisibilitySchema.parse(formData.get('visibility') ?? '');

    await requireLeagueAdmin(leagueId);

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.from('leagues').update({ visibility }).eq('id', leagueId);

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

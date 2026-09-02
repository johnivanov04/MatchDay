'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireLeagueAdmin } from '@/lib/auth/authorization';
import { MATCH_NOTICES, matchPathWithNotice } from '@/lib/auth/page-guards';
import { requireSessionUser } from '@/lib/auth/session';
import { actionFailure, actionSuccess, DomainError, type ActionResult } from '@/lib/errors';
import { domainErrorFromDatabase } from '@/lib/errors-from-database';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  createMatchSchema,
  hoursToInterval,
  matchAdminNotesSchema,
  matchTemplateSchema,
  updateDraftMatchSchema,
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
    // No `?? '2'` / `?? '24'` any more. Every form that posts here renders
    // these inputs and pre-fills them from the league's own defaults, so a
    // missing value means a malformed submission — and `hoursSchema` should
    // say so rather than a constant quietly standing in for a policy the
    // league has already expressed.
    signup_closes_before_hours: formData.get('signup_closes_before_hours') ?? '',
    cancellation_cutoff_before_hours: formData.get('cancellation_cutoff_before_hours') ?? '',
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
 * Which button was pressed.
 *
 * A submit button contributes its own `name`/`value`, so the two outcomes are
 * one form and one action rather than two of each. Parsed strictly: anything
 * that is not the publish intent is treated as a draft, so a malformed or
 * absent value can only ever produce the *safer* of the two — a match nobody
 * has been notified about.
 */
function isPublishIntent(formData: FormData): boolean {
  return formData.get('intent') === 'publish';
}

/**
 * Creates a match, as a draft or open in one step.
 *
 * ── WHY BOTH LIVE IN ONE ACTION ────────────────────────────────────────────
 *
 * Identical input, identical validation, identical redirect; the only
 * difference is which database function runs. Splitting them would mean two
 * copies of the twenty-argument mapping below, and the day somebody adds a
 * field to the form they would fix one.
 *
 * ── WHY PUBLISHING IS ONE RPC AND NOT TWO ──────────────────────────────────
 *
 * `create_and_publish_match()` calls `create_match()` then `publish_match()`
 * inside one transaction, so a publication that fails leaves nothing behind.
 * Doing it here as two sequential calls would leave an unexplained draft every
 * time the second one failed — which is the exact failure mode this whole
 * change exists to remove.
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
  let matchId: string;
  let published: boolean;

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

    // The same schema for both paths, before either. Publishing cannot become a
    // way to get data past a check the draft path applies.
    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', { fieldErrors: toFieldErrors(parsed.error) });
    }

    published = isPublishIntent(formData);

    // Byte-identical arguments either way: a draft and a published match made
    // from the same form differ in `status` and nothing else.
    const args = {
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
    };

    const supabase = await createSupabaseServerClient();
    const { data, error } = published
      ? await supabase.rpc('create_and_publish_match', args)
      : await supabase.rpc('create_match', args);

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    // Both functions return the new match's id. It was previously discarded,
    // which is why this used to redirect to the list — there was nothing else
    // it could point at.
    matchId = z.uuid().parse(data);
  } catch (error: unknown) {
    return actionFailure(error);
  }

  revalidatePath('/', 'layout');
  redirect(
    matchPathWithNotice(
      slug,
      matchId,
      published ? MATCH_NOTICES.published : MATCH_NOTICES.draftSaved,
    ),
  );
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
  } catch (error: unknown) {
    return actionFailure(error);
  }

  revalidatePath('/', 'layout');
  return actionSuccess();
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

  } catch (error: unknown) {
    return actionFailure(error);
  }

  revalidatePath('/', 'layout');
  return actionSuccess();
}

/**
 * Editing a draft.
 *
 * Goes through `update_draft_match()` rather than the `matches_update_draft_admin`
 * UPDATE policy, so that resolving a local date and wall-clock time into an
 * instant stays in the database next to `create_match()`. Doing it here would
 * put a second daylight-saving implementation in the system.
 *
 * Notifies nobody: a draft has never been visible to a member, so there is no
 * expectation to correct. The audit event comes from the existing trigger.
 */
export async function updateDraftMatchAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  let destination: string;

  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    const matchId = z.uuid().parse(formData.get('match_id') ?? '');
    const slug = z.string().min(1).parse(formData.get('league_slug') ?? '');
    await requireLeagueAdmin(leagueId);

    const parsed = updateDraftMatchSchema.safeParse({
      ...readTemplateForm(formData),
      name: 'unused',
      title: formData.get('title') ?? '',
      match_date: formData.get('match_date') ?? '',
      public_notes: formData.get('public_notes') ?? '',
    });

    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', { fieldErrors: toFieldErrors(parsed.error) });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('update_draft_match', {
      p_match_id: matchId,
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
      p_location_map_url: parsed.data.location_map_url,
      p_priority_window: hoursToInterval(parsed.data.priority_window_hours),
      p_signup_closes_before: `${parsed.data.signup_closes_before_hours} hours`,
      p_cancellation_cutoff_before: `${parsed.data.cancellation_cutoff_before_hours} hours`,
      p_roster_publish_before: hoursToInterval(parsed.data.roster_publish_before_hours),
      p_public_notes: parsed.data.public_notes,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    destination = matchPathWithNotice(slug, matchId, MATCH_NOTICES.saved);
  } catch (error: unknown) {
    return actionFailure(error);
  }

  // Outside the try, because `redirect()` signals by throwing and
  // `actionFailure` would otherwise swallow it into a generic failure.
  revalidatePath('/', 'layout');
  redirect(destination);
}

/**
 * The deliberate, audited edit path for a published match.
 *
 * A direct UPDATE is refused by `matches_update_draft_admin`, so this is the
 * only way an open match changes. It bumps the revision, writes an audit event
 * and notifies members — all in one transaction.
 *
 * The revision the form was rendered from is submitted with it. If somebody
 * else edited in the meantime the database refuses, rather than silently
 * overwriting their change and telling members about a time that no longer
 * applies.
 */
export async function updatePublishedMatchAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  let destination: string;

  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    const matchId = z.uuid().parse(formData.get('match_id') ?? '');
    const slug = z.string().min(1).parse(formData.get('league_slug') ?? '');
    await requireLeagueAdmin(leagueId);

    // Absent means "do not check" at the database. The edit form always sends
    // it; only a hand-rolled request could omit it.
    const rawRevision = formData.get('expected_revision');
    const expectedRevision =
      typeof rawRevision === 'string' && rawRevision !== ''
        ? z.coerce.number().int().min(0).parse(rawRevision)
        : null;

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
    const { error } = await supabase.rpc('update_published_match', {
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
      p_expected_revision: expectedRevision,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    destination = matchPathWithNotice(slug, matchId, MATCH_NOTICES.saved);
  } catch (error: unknown) {
    return actionFailure(error);
  }

  revalidatePath('/', 'layout');
  redirect(destination);
}

/**
 * Administrator notes.
 *
 * Saved on their own, separately from the match, because they live in their own
 * admin-only table — `match_admin_notes` — precisely so that a member reading
 * the match row cannot read them. Row Level Security filters rows, not columns.
 *
 * Notifies nobody. Notes are the administrator's private working memory; a
 * member being told that a note about them changed would be worse than useless.
 * The audit trigger deliberately records only that notes changed, never their
 * text, because audit rows are readable by every future administrator.
 */
export async function saveMatchAdminNotesAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  let destination: string;

  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    const matchId = z.uuid().parse(formData.get('match_id') ?? '');
    const slug = z.string().min(1).parse(formData.get('league_slug') ?? '');
    const { membership } = await requireLeagueAdmin(leagueId);

    const parsedNotes = matchAdminNotesSchema.safeParse({
      notes: String(formData.get('notes') ?? ''),
    });
    if (!parsedNotes.success) {
      throw new DomainError('VALIDATION_FAILED', { fieldErrors: toFieldErrors(parsedNotes.error) });
    }
    const notes = parsedNotes.data.notes;

    const supabase = await createSupabaseServerClient();

    const { error } =
      notes === ''
        ? await supabase
            .from('match_admin_notes')
            .delete()
            .eq('match_id', matchId)
            .eq('league_id', leagueId)
        : await supabase.from('match_admin_notes').upsert(
            // `updated_by` comes from the membership the guard just verified,
            // never from the form. It is what makes the row say who wrote it,
            // matching what `create_match()` records.
            { match_id: matchId, league_id: leagueId, notes, updated_by: membership.user_id },
            { onConflict: 'match_id' },
          );

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    destination = matchPathWithNotice(slug, matchId, MATCH_NOTICES.notesSaved);
  } catch (error: unknown) {
    return actionFailure(error);
  }

  revalidatePath('/', 'layout');
  redirect(destination);
}

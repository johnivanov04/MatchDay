'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireLeagueAdmin } from '@/lib/auth/authorization';
import { requireSessionUser } from '@/lib/auth/session';
import { actionFailure, actionSuccess, DomainError, type ActionResult } from '@/lib/errors';
import { domainErrorFromDatabase } from '@/lib/errors-from-database';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { guidelineAcceptanceSchema, guidelineDraftSchema } from '@/lib/validation/guideline';
import { toFieldErrors } from '@/lib/validation/profile';

/**
 * Guideline administration and acceptance.
 *
 * Each action is an untrusted POST endpoint, so each re-derives the actor from
 * the session and re-checks authorization. The database repeats every check
 * independently.
 */

export async function createGuidelineDraftAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    await requireLeagueAdmin(leagueId);

    const parsed = guidelineDraftSchema.safeParse({
      version_label: formData.get('version_label') ?? '',
      title: formData.get('title') ?? '',
      body: formData.get('body') ?? '',
      document_url: formData.get('document_url') ?? '',
      requires_acceptance: formData.get('requires_acceptance') === 'on',
      effective_at: formData.get('effective_at') ?? '',
    });

    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', { fieldErrors: toFieldErrors(parsed.error) });
    }

    const user = await requireSessionUser();
    const supabase = await createSupabaseServerClient();

    // A version is always born a draft; the INSERT policy refuses anything
    // else. Publication is a separate, audited step.
    const { error } = await supabase.from('guideline_versions').insert({
      league_id: leagueId,
      version_label: parsed.data.version_label,
      title: parsed.data.title,
      body: parsed.data.body,
      document_url: parsed.data.document_url,
      requires_acceptance: parsed.data.requires_acceptance,
      ...(parsed.data.effective_at === null ? {} : { effective_at: parsed.data.effective_at }),
      created_by: user.id,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error, { VALIDATION_FAILED: 'version_label' });
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/** Edits a draft. Published versions are frozen — both the policy and a trigger say so. */
export async function updateGuidelineDraftAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    const versionId = z.uuid().parse(formData.get('version_id') ?? '');
    await requireLeagueAdmin(leagueId);

    const parsed = guidelineDraftSchema.safeParse({
      version_label: formData.get('version_label') ?? '',
      title: formData.get('title') ?? '',
      body: formData.get('body') ?? '',
      document_url: formData.get('document_url') ?? '',
      requires_acceptance: formData.get('requires_acceptance') === 'on',
      effective_at: formData.get('effective_at') ?? '',
    });

    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', { fieldErrors: toFieldErrors(parsed.error) });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase
      .from('guideline_versions')
      .update({
        version_label: parsed.data.version_label,
        title: parsed.data.title,
        body: parsed.data.body,
        document_url: parsed.data.document_url,
        requires_acceptance: parsed.data.requires_acceptance,
        ...(parsed.data.effective_at === null ? {} : { effective_at: parsed.data.effective_at }),
      })
      .eq('id', versionId)
      .eq('league_id', leagueId);

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
 * Publishes a draft: freezes the text, and tells every active member.
 *
 * Push dispatch runs after the RPC returns, never inside it. The canonical
 * notifications are committed by then, so a push failure cannot undo the
 * publication.
 */
export async function publishGuidelineVersionAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    const versionId = z.uuid().parse(formData.get('version_id') ?? '');
    await requireLeagueAdmin(leagueId);

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('publish_guideline_version', {
      p_guideline_version_id: versionId,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

export async function archiveGuidelineVersionAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    const versionId = z.uuid().parse(formData.get('version_id') ?? '');
    await requireLeagueAdmin(leagueId);

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('archive_guideline_version', {
      p_guideline_version_id: versionId,
    });

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
 * Accepts a guideline version, for the caller's own membership only.
 *
 * There is no parameter for whose acceptance this is — the database takes it
 * from the session — so "accept on behalf of" is not expressible, including by
 * an administrator. The `confirm` literal makes a missing checkbox a refusal
 * rather than a default: 02 §8 requires acceptance never be prechecked.
 */
export async function acceptGuidelineVersionAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    await requireSessionUser();

    const parsed = guidelineAcceptanceSchema.safeParse({
      guideline_version_id: formData.get('guideline_version_id') ?? '',
      confirm: formData.get('confirm') ?? '',
    });

    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', { fieldErrors: toFieldErrors(parsed.error) });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('accept_guideline_version', {
      p_guideline_version_id: parsed.data.guideline_version_id,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

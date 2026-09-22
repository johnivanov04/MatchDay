'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireSessionUser } from '@/lib/auth/session';
import { actionFailure, actionSuccess, DomainError, type ActionResult } from '@/lib/errors';
import { domainErrorFromDatabase } from '@/lib/errors-from-database';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { ReportReason, ReportTargetType } from '@/types/database';

/**
 * Reporting and blocking — App Review Guideline 1.2.
 *
 * ── NOTHING HERE TALKS TO A PROVIDER ───────────────────────────────────────
 *
 * Filing a report writes a row and returns. The escalation email is sent by
 * `/api/cron/report-escalation`, on the same cron pattern as every other send
 * since Phase 3B. A member pressing "Report" must not wait on Resend, and
 * Resend being down must not be able to stop a report being recorded — which is
 * exactly the failure mode that moving provider calls out of the request path
 * was meant to end.
 *
 * ── THE DATABASE IS THE AUTHORITY, NOT THIS FILE ───────────────────────────
 *
 * `submit_content_report` re-derives the reporter from `auth.uid()` and checks
 * that they can actually see the thing they are reporting. The validation below
 * is there to give a person a clean message instead of a constraint violation;
 * it is not what makes the operation safe.
 */

const REPORT_REASONS = [
  'harassment',
  'hate_speech',
  'sexual_content',
  'violence_or_threats',
  'spam',
  'impersonation',
  'other',
] as const satisfies readonly ReportReason[];

const REPORT_TARGETS = ['user', 'league', 'match', 'guideline'] as const satisfies readonly ReportTargetType[];

const reportSchema = z.object({
  target_type: z.enum(REPORT_TARGETS),
  target_id: z.string().uuid(),
  reason: z.enum(REPORT_REASONS),
  // Bounded here and in the database. Optional, because a reason category is
  // often the whole story and demanding prose is a reason not to report.
  details: z
    .string()
    .trim()
    .max(1000, 'Keep this under 1000 characters.')
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value)),
});

const targetUserSchema = z.object({ user_id: z.string().uuid() });

export async function submitContentReportAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    await requireSessionUser();

    const parsed = reportSchema.safeParse({
      target_type: formData.get('target_type') ?? '',
      target_id: formData.get('target_id') ?? '',
      reason: formData.get('reason') ?? '',
      details: formData.get('details') ?? undefined,
    });

    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', {
        fieldErrors: { form: 'Choose a reason and try again.' },
      });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('submit_content_report', {
      p_target_type: parsed.data.target_type,
      p_target_id: parsed.data.target_id,
      p_reason: parsed.data.reason,
      p_details: parsed.data.details,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    return actionSuccess(undefined);
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

export async function blockUserAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    await requireSessionUser();

    const parsed = targetUserSchema.safeParse({ user_id: formData.get('user_id') ?? '' });
    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', {
        fieldErrors: { form: 'That member is not available.' },
      });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('block_user', { p_user_id: parsed.data.user_id });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    // Rosters and team sheets render names, and a blocked member's name changes
    // on every one of them. `revalidatePath('/', 'layout')` looked like it
    // covered that and does not: it invalidates the layout, while the match
    // pages are dynamic routes cached per path. The end-to-end test caught a
    // reload still showing the blocked member's name.
    //
    // `'page'` on the dynamic segment invalidates every match page at once,
    // which is what a block has to do — somebody blocked on one roster is
    // blocked on all of them.
    revalidatePath('/leagues/[slug]/matches/[matchId]', 'page');
    revalidatePath('/settings/blocked');
    revalidatePath('/', 'layout');
    return actionSuccess(undefined);
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

export async function unblockUserAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    await requireSessionUser();

    const parsed = targetUserSchema.safeParse({ user_id: formData.get('user_id') ?? '' });
    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', {
        fieldErrors: { form: 'That member is not available.' },
      });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('unblock_user', { p_user_id: parsed.data.user_id });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/leagues/[slug]/matches/[matchId]', 'page');
    revalidatePath('/settings/blocked');
    revalidatePath('/', 'layout');
    return actionSuccess(undefined);
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

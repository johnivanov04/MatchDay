'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireLeagueAdmin } from '@/lib/auth/authorization';
import { requireSessionUser } from '@/lib/auth/session';
import { getSiteUrl } from '@/lib/env';
import { actionFailure, actionSuccess, DomainError, type ActionResult } from '@/lib/errors';
import { domainErrorFromDatabase } from '@/lib/errors-from-database';
import {
  buildInviteUrl,
  generateInviteToken,
  isPlausibleInviteToken,
} from '@/lib/leagues/invite-token';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { inviteOptionsSchema } from '@/lib/validation/league';
import { toFieldErrors } from '@/lib/validation/profile';

export interface CreatedInvite {
  /** Shown to the administrator once. Never stored, never retrievable again. */
  url: string;
  expiresInDays: number;
}

/**
 * Creates a revocable invitation link.
 *
 * The token is generated here from 32 CSPRNG bytes and travels to the database
 * exactly once, where `create_league_invite()` stores only its SHA-256 digest.
 * The raw value is returned to this administrator and then dropped — there is
 * no code path that can recover it later, which is why the UI must present it
 * immediately.
 */
export async function createInviteAction(
  _previous: ActionResult<CreatedInvite> | null,
  formData: FormData,
): Promise<ActionResult<CreatedInvite>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    await requireLeagueAdmin(leagueId);

    const parsed = inviteOptionsSchema.safeParse({
      label: formData.get('label') ?? '',
      grants_status: formData.get('grants_status') ?? 'active',
      max_uses: formData.get('max_uses') ?? '',
      expires_in_days: formData.get('expires_in_days') ?? '14',
    });

    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', { fieldErrors: toFieldErrors(parsed.error) });
    }

    const token = generateInviteToken();

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('create_league_invite', {
      p_league_id: leagueId,
      p_token: token,
      p_label: parsed.data.label,
      p_grants_status: parsed.data.grants_status,
      p_max_uses: parsed.data.max_uses,
      p_expires_in_days: parsed.data.expires_in_days,
    });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/', 'layout');
    return actionSuccess({
      url: buildInviteUrl(getSiteUrl(), token),
      expiresInDays: parsed.data.expires_in_days,
    });
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

/** Revokes an invitation immediately. Idempotent. */
export async function revokeInviteAction(
  _previous: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  try {
    const leagueId = z.uuid().parse(formData.get('league_id') ?? '');
    await requireLeagueAdmin(leagueId);

    const inviteId = z.uuid().parse(formData.get('invite_id') ?? '');

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('revoke_league_invite', { p_invite_id: inviteId });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }

    revalidatePath('/', 'layout');
    return actionSuccess();
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

export interface RedeemedInvite {
  leagueId: string;
  status: string;
  joined: boolean;
}

/**
 * Redeems an invitation token.
 *
 * Every failure — unknown token, expired, revoked, usage exhausted — surfaces
 * as the same `INVITE_INVALID`, so a caller feeding guessed tokens learns
 * nothing about which private leagues exist.
 *
 * Redeeming twice, or redeeming while already a member, returns the existing
 * membership and does not consume a use.
 */
export async function redeemInviteAction(
  _previous: ActionResult<RedeemedInvite> | null,
  formData: FormData,
): Promise<ActionResult<RedeemedInvite>> {
  try {
    await requireSessionUser();

    const token = String(formData.get('token') ?? '');
    if (!isPlausibleInviteToken(token)) {
      throw new DomainError('INVITE_INVALID');
    }

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc('redeem_league_invite', { p_token: token });

    if (error !== null) {
      throw domainErrorFromDatabase(error);
    }
    if (data === null) {
      throw new DomainError('INVITE_INVALID');
    }

    revalidatePath('/', 'layout');
    return actionSuccess({
      leagueId: data.league_id,
      status: data.status,
      joined: data.joined,
    });
  } catch (error: unknown) {
    return actionFailure(error);
  }
}

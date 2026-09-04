import 'server-only';

import { createSupabaseAdminClient, isServiceRoleConfigured } from '@/lib/supabase/admin';

/**
 * Which delivery channels a notification is owed, if any.
 *
 * ── ONE PLACE, AND IT IS IN SQL ────────────────────────────────────────────
 *
 * `notification_channel_eligibility` holds every rule: the per-type override,
 * the Phase 3D global email master, the deletion state and the confirmed
 * address. This module is the thin seam that carries the answer to the worker.
 *
 * Provider code never asks a preference question and preference code never asks
 * a provider question. "Has this person got any enabled devices" stays where it
 * already was — inside the push dispatcher, which finds none and attempts
 * nothing.
 *
 * ── A DISABLED CHANNEL IS NOT A FAILURE ────────────────────────────────────
 *
 * It is not owed. No provider call, no attempt row, no Phase 3C retry budget,
 * and no `temporary_failure` — there is nothing to come back for. That
 * distinction is the whole reason this resolves before dispatch rather than
 * inside it.
 */

export interface ChannelEligibility {
  /** False only when an explicit per-type override says so. */
  pushAllowed: boolean;
  /**
   * The address to send to, or `null` for "email is not owed".
   *
   * `null` covers every reason at once — global switch off, type switched off,
   * account deleting, address missing or unverified — because the worker treats
   * them identically and none of them is worth distinguishing at the point of
   * delivery.
   */
  emailAddress: string | null;
}

export interface ChannelEligibilityStore {
  resolve(notificationId: string): Promise<ChannelEligibility>;
}

/** Returns `null` with no service-role key, matching the other delivery stores. */
export function createChannelEligibilityStore(): ChannelEligibilityStore | null {
  if (!isServiceRoleConfigured()) {
    return null;
  }

  let client: ReturnType<typeof createSupabaseAdminClient>;
  try {
    client = createSupabaseAdminClient();
  } catch {
    return null;
  }

  return {
    async resolve(notificationId: string): Promise<ChannelEligibility> {
      const { data, error } = await client.rpc('notification_channel_eligibility', {
        p_notification_id: notificationId,
      });

      // A refusal is not "nothing is owed" — it is the resolver being broken,
      // and silently treating it as a no-op would drop delivery without a
      // trace. Thrown so the worker records the pass as aborted rather than
      // completing a job it never evaluated.
      if (error !== null) {
        throw error;
      }

      const row = data?.[0];

      // No row means the notification does not exist. Nothing is owed, and
      // nothing about that is retryable.
      return {
        pushAllowed: row?.push_allowed ?? false,
        emailAddress: row?.email_address ?? null,
      };
    },
  };
}

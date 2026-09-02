import 'server-only';

import { createSupabaseAdminClient, isServiceRoleConfigured } from '@/lib/supabase/admin';
import type { ClaimedDeliveryJob } from '@/types/database';

/**
 * The worker's view of the delivery queue.
 *
 * Every operation is an RPC rather than a table statement, for the same reason
 * `push-store.ts` gives: the functions carry the `auth.role()` check and the
 * clamping, so a future caller that reaches the queue by some other route still
 * cannot claim a thousand jobs or move one back to `pending`. The table grants
 * exist for operators with a psql prompt, not for this code.
 *
 * Returns `null` when no service-role key is configured, matching
 * `createPushDispatchStore`. A deployment without one delivers nothing and says
 * so, rather than crashing a cron route.
 */
export interface DeliveryQueueStore {
  /**
   * Takes ownership of up to `limit` jobs for `leaseSeconds`.
   *
   * The lease is the only thing standing between a killed worker and a job
   * stuck in `processing` for ever. It is deliberately **not** a retry
   * schedule — a job whose provider call failed is finished, not re-queued.
   */
  claim(worker: string, limit: number, leaseSeconds: number): Promise<ClaimedDeliveryJob[]>;
  /** True when this call is what moved the job; false if something else already did. */
  complete(jobId: string): Promise<boolean>;
  fail(jobId: string, errorCategory: string | null): Promise<boolean>;
}

export function createDeliveryQueueStore(): DeliveryQueueStore | null {
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
    async claim(worker, limit, leaseSeconds) {
      const { data, error } = await client.rpc('claim_notification_delivery_jobs', {
        p_worker: worker,
        p_limit: limit,
        p_lease_seconds: leaseSeconds,
      });

      // A failed claim is a failed run, not an empty one — the caller
      // distinguishes them, because a queue that cannot be read looks exactly
      // like a queue with nothing in it and must not be reported as idle.
      if (error !== null) {
        throw error;
      }

      return data ?? [];
    },

    async complete(jobId) {
      const { data, error } = await client.rpc('complete_notification_delivery_job', {
        p_job_id: jobId,
        p_status: 'completed',
        p_error_category: null,
      });
      if (error !== null) {
        throw error;
      }
      return data === true;
    },

    async fail(jobId, errorCategory) {
      const { data, error } = await client.rpc('complete_notification_delivery_job', {
        p_job_id: jobId,
        p_status: 'failed',
        p_error_category: errorCategory,
      });
      if (error !== null) {
        throw error;
      }
      return data === true;
    },
  };
}

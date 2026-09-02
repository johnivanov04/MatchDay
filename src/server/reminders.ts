import 'server-only';

import { logError, logInfo, logWarn } from '@/lib/observability/log';
import { createSupabaseAdminClient, isServiceRoleConfigured } from '@/lib/supabase/admin';

/**
 * One pass of the reminder worker.
 *
 * This claims every due reminder and writes the canonical notifications. It
 * does **not** deliver them.
 *
 * It used to. Phase 3B moved delivery behind a durable queue: the trigger on
 * `notifications` enqueues a job in the same transaction that writes the row,
 * and `/api/cron/notification-delivery` drains it. That removes the one thing
 * this module could never bound — a generator that claimed a hundred
 * occurrences then sat in a loop talking to Apple, inside a function with a
 * wall clock, with no record of where it stopped if it ran out of time.
 *
 * The property that mattered is unchanged and now holds by construction: a push
 * that does not go out cannot cost a reminder, because the canonical record is
 * committed before anything is owed to any provider.
 *
 * Uses the service-role client because the generator writes notifications
 * addressed to many different users, which no client session may do. The
 * function also re-checks the role itself, so a leaked call through another
 * path is still refused.
 */

/**
 * How the pass ended.
 *
 * FOUR OUTCOMES, NOT A COUNT. This used to return `{claimed: 0, notified: 0,
 * skipped: false}` for *both* "nothing was due" and "the database call failed",
 * which made a broken reminder pipeline indistinguishable from a quiet Tuesday
 * — from the response body, from the logs, and from anything an operator could
 * alert on. A league would simply stop being reminded and nobody would find out
 * until players started missing matches.
 */
export type ReminderRunStatus =
  /** The generator ran and there was nothing due. The healthy common case. */
  | 'idle'
  /** The generator ran and claimed at least one occurrence. */
  | 'worked'
  /** No service-role key is configured, so nothing ran. Misconfiguration. */
  | 'skipped'
  /** The generator was called and refused or errored. Nothing was claimed. */
  | 'failed';

export interface ReminderRunResult {
  status: ReminderRunStatus;
  /** Reminder occurrences claimed by this pass. Always 0 unless `worked`. */
  claimed: number;
  /** Canonical notifications created across those occurrences. */
  notified: number;
  /**
   * Stable error code when `status` is `failed`, for correlating log lines.
   * Never the database's message, which can name constraints and other tenants.
   */
  errorCode: string | null;
}

/** Kept so callers and tests can ask the question without restating it. */
export function reminderRunFailed(result: ReminderRunResult): boolean {
  return result.status === 'failed';
}

export async function runDueReminders(limit = 100): Promise<ReminderRunResult> {
  if (!isServiceRoleConfigured()) {
    // A deployment that never sends a reminder because a variable is unset is
    // the failure this whole module exists to make visible, so it is `warn`
    // rather than `info` — but it is not `failed`, because nothing was
    // attempted and retrying will not help until an operator acts.
    // `service_role_configured`, not `reason`: the key filter drops anything
    // containing `reason`, so the original field never reached the log line.
    logWarn('reminder.skipped', { service_role_configured: false });
    return { status: 'skipped', claimed: 0, notified: 0, errorCode: null };
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('generate_due_reminders', { p_limit: limit });

  if (error !== null || data === null) {
    // The scheduler will retry, and the claimed rows are still pending — but
    // this is emphatically NOT a zero-work success, and it no longer reports
    // itself as one. The code is logged; the message is not, because a
    // PostgreSQL error can carry a constraint name or another league's id.
    const errorCode = typeof error?.code === 'string' ? error.code : 'unknown';
    logError('reminder.failed', { error_code: errorCode });
    return { status: 'failed', claimed: 0, notified: 0, errorCode };
  }

  const claimed = data.length;
  const notified = data.reduce((total, row) => total + row.notified, 0);

  // Counts and ids only. No league name, no match title, no recipient — a log
  // line is read by more people and kept longer than any screen in the product.
  //
  // `notified` is now the number of reminders *enqueued* for delivery as well
  // as written, since the trigger fires on the same insert. Whether they
  // reached a phone is the delivery worker's log line to write, not this one's.
  logInfo('reminder.run', { claimed, notified });

  return {
    status: claimed === 0 ? 'idle' : 'worked',
    claimed,
    notified,
    errorCode: null,
  };
}

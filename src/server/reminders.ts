import 'server-only';

import { logError, logInfo, logWarn } from '@/lib/observability/log';
import { dispatchPushForKeyPrefix } from '@/lib/push/notify';
import { createSupabaseAdminClient, isServiceRoleConfigured } from '@/lib/supabase/admin';

/**
 * One pass of the reminder worker.
 *
 * Two steps, deliberately in this order and with a hard boundary between them:
 *
 *   1. the database claims every due reminder and writes the canonical
 *      notifications, committing;
 *   2. only then is push attempted, and only for the batches step 1 actually
 *      created.
 *
 * Step 2 cannot undo step 1. A push service that is down, a device whose
 * subscription has expired, or a crash between the two leaves every reminder
 * sitting in the inbox where it belongs — which is the whole reason the
 * canonical record is the source of truth and push is a delivery channel.
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
   * Occurrences whose push fan-out threw after the notifications had committed.
   *
   * Not a failure of the run: the inbox already has the reminder. Surfaced so a
   * push pipeline that is down consistently is visible before anybody notices
   * their phone has gone quiet.
   */
  pushFailures: number;
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
    return { status: 'skipped', claimed: 0, notified: 0, pushFailures: 0, errorCode: null };
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
    return { status: 'failed', claimed: 0, notified: 0, pushFailures: 0, errorCode };
  }

  const claimed = data.length;
  const notified = data.reduce((total, row) => total + row.notified, 0);

  // Per claimed occurrence, so this pushes exactly what it just created rather
  // than re-walking every reminder notification that has ever existed.
  let pushFailures = 0;
  for (const row of data) {
    try {
      await dispatchPushForKeyPrefix(`reminder:${row.reminder_id}`);
    } catch {
      // The notification is already committed; push is best effort. Counted,
      // not swallowed, so a consistently failing push pipeline is visible.
      pushFailures += 1;
    }
  }

  // Counts and ids only. No league name, no match title, no recipient — a log
  // line is read by more people and kept longer than any screen in the product.
  logInfo('reminder.run', { claimed, notified, push_failures: pushFailures });

  if (pushFailures > 0) {
    logWarn('reminder.push_incomplete', { claimed, push_failures: pushFailures });
  }

  return {
    status: claimed === 0 ? 'idle' : 'worked',
    claimed,
    notified,
    pushFailures,
    errorCode: null,
  };
}

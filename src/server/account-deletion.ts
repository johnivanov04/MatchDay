import 'server-only';

import {
  deleteAvatarObjects,
  finalizeAndDeleteAuth,
  type DeletionOutcome,
} from '@/lib/account/deletion';
import { logError, logInfo, logWarn } from '@/lib/observability/log';
import { createSupabaseAdminClient, isServiceRoleConfigured } from '@/lib/supabase/admin';

/**
 * One pass of the account-deletion reconciler.
 *
 * ── WHY THIS EXISTS AND IS NOT "AN OPERATOR CAN RUN A QUERY" ───────────────
 *
 * Account deletion crosses three systems that cannot share a transaction, so it
 * can stop half-finished: Storage unreachable, the scrub not run, or — the one
 * that matters most — the Postgres side scrubbed while the Auth row survives.
 * That last state is the dangerous one, because MatchDay *looks* anonymous
 * while `auth.users` still holds the person's real email address. It is not a
 * deleted account; it is an account that looks deleted.
 *
 * Whether it finishes cannot depend on the user remembering to come back. They
 * have, by definition, just tried to leave.
 *
 * ── WHAT IT MAY AND MAY NOT TOUCH ──────────────────────────────────────────
 *
 * `accounts_awaiting_deletion()` returns only profiles that already carry
 * `deletion_started_at`, and `finalize_account_deletion()` refuses any profile
 * that does not. So the reconciler holds a service-role capability it cannot
 * point at a live account — not by convention, but because the database will
 * not do it.
 *
 * ── CADENCE ────────────────────────────────────────────────────────────────
 *
 * Hourly, declared in `vercel.json`. This is a safety net behind a user-facing
 * retry that works immediately: the common case is that nothing needs doing,
 * and the rare case is a transient outage that is not resolved any faster by
 * asking again every ten minutes. Reminders run every ten minutes because a
 * player misses a match if they are late; nobody is harmed by an account
 * finishing its deletion forty minutes later than it might have.
 */

/** How many accounts one pass will attempt. Deliberately small. */
const BATCH_LIMIT = 25;

export type AccountDeletionRunStatus =
  /** The reconciler ran and found nothing outstanding. The healthy common case. */
  | 'idle'
  /** The reconciler ran and advanced at least one account. */
  | 'worked'
  /** No service-role key configured, so nothing ran. Misconfiguration. */
  | 'skipped'
  /** The listing call itself failed. Nothing was attempted. */
  | 'failed';

export interface AccountDeletionRunResult {
  status: AccountDeletionRunStatus;
  /** Accounts found in a not-demonstrably-complete state. */
  found: number;
  /** Accounts that finished during this pass. */
  completed: number;
  /**
   * Accounts still unfinished after this pass.
   *
   * Not a failure of the run — a push service or GoTrue being briefly
   * unreachable is ordinary — but a number that stays above zero across passes
   * is the signal that something needs a person.
   */
  outstanding: number;
}

export async function runAccountDeletionReconciliation(): Promise<AccountDeletionRunResult> {
  if (!isServiceRoleConfigured()) {
    logWarn('account_deletion.reconcile_skipped', { service_role_configured: false });
    return { status: 'skipped', found: 0, completed: 0, outstanding: 0 };
  }

  const admin = createSupabaseAdminClient();

  const { data, error } = await admin.rpc('accounts_awaiting_deletion', { p_limit: BATCH_LIMIT });

  if (error !== null) {
    // SQLSTATE only. A PostgreSQL message can carry column values and
    // identifiers, and the rows this query returns are about people.
    logError('account_deletion.reconcile_failed', {
      severity: 'unexpected',
      sqlstate: typeof error.code === 'string' ? error.code : null,
    });
    return { status: 'failed', found: 0, completed: 0, outstanding: 0 };
  }

  const accounts = data ?? [];
  if (accounts.length === 0) {
    return { status: 'idle', found: 0, completed: 0, outstanding: 0 };
  }

  let completed = 0;
  let outstanding = 0;

  for (const account of accounts) {
    // One account's failure must not abandon the rest of the batch.
    try {
      const outcome = await reconcileOne(admin, account.profile_id, account.deleted_at !== null);
      if (outcome === 'complete') {
        completed += 1;
      } else {
        outstanding += 1;
      }
    } catch {
      // Already logged with a severity by the helpers. No identifier here: a
      // profile id is a stable handle on a person who has asked to be forgotten.
      outstanding += 1;
    }
  }

  logInfo('account_deletion.reconciled', {
    found: accounts.length,
    completed,
    outstanding,
  });

  return {
    status: completed > 0 ? 'worked' : 'idle',
    found: accounts.length,
    completed,
    outstanding,
  };
}

/**
 * Finishes one account, from wherever it stopped.
 *
 * The admin client rather than a session, because there is no session — nobody
 * is signed in as this person and, if the Auth row is already gone, nobody ever
 * can be again. Ownership is not asserted from the client here; it is asserted
 * by the database refusing any profile that is not already deleting.
 */
async function reconcileOne(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  profileId: string,
  alreadyScrubbed: boolean,
): Promise<DeletionOutcome> {
  // Only when the scrub has not run. A tombstoned profile has already had its
  // folder emptied, and re-listing it every hour for an account waiting on
  // GoTrue is work with no possible result.
  if (!alreadyScrubbed) {
    await deleteAvatarObjects(admin, profileId);
  }

  return finalizeAndDeleteAuth(async () => {
    const { error } = await admin.rpc('finalize_account_deletion', { p_profile_id: profileId });
    if (error !== null) {
      throw new Error(`finalize_account_deletion failed (${error.code ?? 'unknown'})`, {
        cause: error,
      });
    }
  }, profileId);
}

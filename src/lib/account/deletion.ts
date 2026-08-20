import 'server-only';

import { logError, logInfo, logWarn } from '@/lib/observability/log';
import { createSupabaseAdminClient, isServiceRoleConfigured } from '@/lib/supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

/**
 * The parts of account deletion that are not a database transaction.
 *
 * ── THE PROBLEM THIS MODULE IS THE SHAPE OF ────────────────────────────────
 *
 * Deleting an account touches three systems and only one of them is
 * transactional:
 *
 *   * **Postgres** — the memberships, the history, the scrub. Atomic.
 *   * **Storage** — the avatar objects. Refuses SQL deletes outright
 *     (`storage.protect_delete` raises on any direct DELETE), so it can only be
 *     reached over HTTP and can only fail independently.
 *   * **GoTrue** — the `auth.users` row, which is what "deleted" actually means
 *     and which still holds the person's real email address until it is gone.
 *
 * No ordering makes that atomic, so the ordering is chosen for what it leaves
 * behind when it breaks:
 *
 *   1. mark the deletion started — one small transaction, and from this instant
 *      the account can do nothing, including upload a new avatar;
 *   2. empty the avatar folder — retryable, and now unable to race an upload;
 *   3. the scrub — one transaction, ending with `deleted_at`;
 *   4. delete the Auth user;
 *   5. reconcile whatever did not finish.
 *
 * The worst state any failure can produce is an account that cannot be used and
 * has not finished being erased. That is recoverable and detectable. The
 * ordering that is *not* used — Auth first — produces an account nobody can
 * sign into whose name and photo are still on every roster, with no way for the
 * owner to come back and finish.
 *
 * Everything here is idempotent. Every failure mode is "run it again", which is
 * what makes both the user's retry button and the cron reconciler safe.
 */

export const AVATAR_BUCKET = 'avatars';

/** How many objects one `list` page returns. Supabase caps this at 100. */
const LIST_PAGE_SIZE = 100;

/** Refuses to loop forever if Storage kept returning full pages. */
const MAX_LIST_PAGES = 50;

type AnySupabase = SupabaseClient<Database>;

export interface AvatarCleanupResult {
  /** Objects found in the folder. */
  found: number;
  /** Objects Storage confirmed removed. */
  removed: number;
}

/**
 * Empties a user's avatar folder.
 *
 * ── THE WHOLE FOLDER, NOT `profile_photo_path` ─────────────────────────────
 *
 * Every upload writes a new `{uid}/{uuid}.jpg` and the previous object is
 * removed afterwards by the application, with failures logged and deliberately
 * swallowed — an orphaned 50 KB object is housekeeping, whereas a profile that
 * will not save because Storage blinked is an outage somebody experiences. The
 * consequence is that a folder can hold several objects while the profile names
 * one. Deleting the named path would leave the others publicly fetchable
 * forever, which is exactly the residue this feature exists to remove.
 *
 * ── PAGINATED, BECAUSE "SEVERAL" HAS NO UPPER BOUND ────────────────────────
 *
 * `list` returns at most 100 entries. Somebody who has changed their photo
 * weekly for two years has more than that, and a single unpaginated call would
 * silently leave the remainder behind — the failure mode being *silence*, which
 * is why this loops rather than assuming.
 *
 * Throws on failure, and that is deliberate: the caller must not proceed to the
 * scrub with images still standing.
 */
export async function deleteAvatarObjects(
  supabase: AnySupabase,
  userId: string,
): Promise<AvatarCleanupResult> {
  const names: string[] = [];

  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const { data, error } = await supabase.storage
      .from(AVATAR_BUCKET)
      .list(userId, { limit: LIST_PAGE_SIZE, offset: page * LIST_PAGE_SIZE });

    if (error !== null) {
      throw new Error(`Could not list avatar objects: ${error.message}`, { cause: error });
    }

    const entries = data ?? [];
    for (const entry of entries) {
      // `list` reports a folder as an entry with no `id`. There are none under
      // an avatar prefix by construction — the path shape is fixed by a CHECK
      // constraint — but a "folder" passed to `remove` is a silent no-op that
      // would make this report success while deleting nothing.
      if (entry.id !== null && entry.id !== undefined) {
        names.push(`${userId}/${entry.name}`);
      }
    }

    if (entries.length < LIST_PAGE_SIZE) {
      break;
    }
  }

  if (names.length === 0) {
    return { found: 0, removed: 0 };
  }

  const { data: removed, error } = await supabase.storage.from(AVATAR_BUCKET).remove(names);

  if (error !== null) {
    throw new Error(`Could not delete avatar objects: ${error.message}`, { cause: error });
  }

  const removedCount = removed?.length ?? 0;

  // A partial removal is a failure, not a warning. Reporting success here would
  // let the scrub proceed and stamp `deleted_at` — a row that promises no
  // personal data remains — while a face is still served from a public URL.
  if (removedCount < names.length) {
    throw new Error(
      `Storage removed ${String(removedCount)} of ${String(names.length)} avatar objects`,
    );
  }

  // Counts only. An object key is a live public URL and never goes in a log.
  logInfo('account_deletion.avatars_removed', { removed: removedCount });

  return { found: names.length, removed: removedCount };
}

/**
 * Deletes the Auth user, and reports whether the identity is now gone.
 *
 * ── WHY A MISSING USER COUNTS AS SUCCESS ───────────────────────────────────
 *
 * The retry and the reconciler both arrive here after somebody else may already
 * have finished. GoTrue answers a delete for an unknown id with an error, and
 * treating that as failure would leave an account permanently "not finished"
 * and permanently retried.
 *
 * Never throws. The caller has already scrubbed Postgres by this point, and an
 * exception here would turn a successful erasure into a visible failure for the
 * user while changing nothing about what remains.
 */
export async function deleteAuthUser(userId: string): Promise<boolean> {
  if (!isServiceRoleConfigured()) {
    // Nothing can proceed without it, and this is a configuration problem an
    // operator has to fix — not a transient one to retry quietly.
    // `service_role_configured`, not `reason` — `logWarn`/`logError` drop any
    // key containing "reason", "email", "auth" and a dozen others outright, so
    // a field named for the obvious thing would silently vanish from the one
    // line an operator needs.
    logError('account_deletion.admin_client_unavailable', {
      severity: 'unexpected',
      service_role_configured: false,
    });
    return false;
  }

  const admin = createSupabaseAdminClient();

  try {
    const { error } = await admin.auth.admin.deleteUser(userId);

    if (error === null) {
      return true;
    }

    // Already gone. Both spellings, because the message is not part of any
    // contract and the status is what actually distinguishes the cases.
    if (error.status === 404) {
      return true;
    }

    // OPERATOR SEVERITY, AND NO EMAIL IN THE PAYLOAD. This is the state in
    // which MatchDay looks anonymous while the Auth row still holds the real
    // address, so it is genuinely not deleted — and the one thing that must not
    // be logged while saying so is the address itself.
    logError('account_deletion.auth_delete_failed', {
      severity: 'unexpected',
      status: error.status ?? null,
    });
    return false;
  } catch {
    logError('account_deletion.auth_delete_failed', {
      severity: 'unexpected',
      status: null,
    });
    return false;
  }
}

export type DeletionOutcome =
  /** Postgres scrubbed and the Auth identity gone. Nothing left to do. */
  | 'complete'
  /** Postgres scrubbed; the Auth identity survived and must be retried. */
  | 'auth_pending';

/**
 * Steps 3–5 for one account: scrub, delete the Auth user, report.
 *
 * Shared by the user's own request and by the reconciler, so the two cannot
 * drift into doing different things — the only difference between them is which
 * Supabase client and which finalize entry point they pass in, and therefore
 * which authorization the database applies.
 */
export async function finalizeAndDeleteAuth(
  finalize: () => Promise<void>,
  userId: string,
): Promise<DeletionOutcome> {
  await finalize();

  const authDeleted = await deleteAuthUser(userId);

  if (!authDeleted) {
    logWarn('account_deletion.auth_pending', {});
    return 'auth_pending';
  }

  logInfo('account_deletion.completed', {});
  return 'complete';
}

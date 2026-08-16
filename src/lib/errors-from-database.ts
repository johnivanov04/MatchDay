import { DOMAIN_ERROR_CODES, DomainError, type DomainErrorCode } from '@/lib/errors';
import { logError } from '@/lib/observability/log';

/**
 * Translates a PostgreSQL error raised by a Phase 2 function into a
 * `DomainError`.
 *
 * The database functions raise messages of the form `CODE: human detail`, where
 * `CODE` is one of the stable codes in 02 §21. Only the code is trusted here —
 * the detail text is discarded rather than forwarded, because PostgreSQL error
 * messages can carry constraint names, column values and identifiers belonging
 * to other tenants, none of which may reach a client.
 *
 * An unrecognised error becomes `NOT_AUTHORIZED`, the least informative
 * outcome, so a new failure mode cannot accidentally leak its message.
 *
 * ── THE FALLBACK IS ALSO WHERE OUTAGES LAND ────────────────────────────────
 *
 * That same catch-all swallows a lost connection, a statement timeout and an
 * unknown constraint violation. Each became an ordinary `DomainError`, which
 * `actionFailure` logs as `action.refused` at **info** — so the one failure an
 * operator most needs paging for was the quietest thing in the logs, while
 * malformed input was the loudest.
 *
 * `domainCodeFromDatabaseError` therefore reports when it had to guess, and the
 * fallback emits `action.dependency_failed`. The returned `DomainError` and the
 * user-visible message are deliberately unchanged: this is classification only.
 */

const DOMAIN_CODE_SET = new Set<string>(DOMAIN_ERROR_CODES);

/** Constraint names whose violation has a clearer domain meaning than the raw error. */
const CONSTRAINT_CODES: ReadonlyArray<readonly [string, DomainErrorCode]> = [
  ['leagues_slug_key', 'SLUG_TAKEN'],
  ['league_join_requests_one_pending_key', 'JOIN_REQUEST_EXISTS'],
  ['league_memberships_league_user_key', 'MEMBERSHIP_EXISTS'],
  ['league_memberships_single_active_admin_key', 'ADMIN_TRANSFER_INVALID'],
  ['LEAGUE_ADMIN_CARDINALITY', 'ADMIN_TRANSFER_INVALID'],
];

export interface DatabaseErrorLike {
  message?: unknown;
  code?: unknown;
}

function messageOf(error: DatabaseErrorLike): string {
  return typeof error.message === 'string' ? error.message : '';
}

/**
 * The mapped code, plus whether it was recognised or fallen back to.
 *
 * Separated so `domainCodeFromDatabaseError` can keep its exact public
 * signature — it is used elsewhere and by tests — while the fallback becomes
 * visible to the one caller that needs to report it.
 */
function classifyDatabaseError(error: DatabaseErrorLike): {
  code: DomainErrorCode;
  recognised: boolean;
} {
  const message = messageOf(error);

  // `CODE: detail` raised by our own functions.
  const prefix = message.split(':', 1)[0]?.trim() ?? '';
  if (DOMAIN_CODE_SET.has(prefix)) {
    return { code: prefix as DomainErrorCode, recognised: true };
  }

  // Constraint violations raised by the schema rather than by a function.
  for (const [needle, code] of CONSTRAINT_CODES) {
    if (message.includes(needle)) {
      return { code, recognised: true };
    }
  }

  return { code: 'NOT_AUTHORIZED', recognised: false };
}

export function domainCodeFromDatabaseError(error: DatabaseErrorLike): DomainErrorCode {
  return classifyDatabaseError(error).code;
}

export function domainErrorFromDatabase(
  error: DatabaseErrorLike,
  fieldFor?: Partial<Record<DomainErrorCode, string>>,
): DomainError {
  const { code, recognised } = classifyDatabaseError(error);

  if (!recognised) {
    // Operator-worthy: the database said something this application does not
    // model, which is what a connection failure, a statement timeout or a new
    // constraint looks like from here.
    //
    // SQLSTATE only. The message is deliberately not logged — it is exactly the
    // string that can carry a constraint name, a column value or another
    // tenant's identifier, which is why it is discarded on the way to the
    // client too.
    logError('action.dependency_failed', {
      severity: 'unexpected',
      sqlstate: typeof error.code === 'string' ? error.code : null,
    });
  }

  const field = fieldFor?.[code];

  return new DomainError(code, {
    cause: error,
    ...(field === undefined
      ? {}
      : { fieldErrors: { [field]: new DomainError(code).userMessage } }),
  });
}

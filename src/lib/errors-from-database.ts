import { DOMAIN_ERROR_CODES, DomainError, type DomainErrorCode } from '@/lib/errors';

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

export function domainCodeFromDatabaseError(error: DatabaseErrorLike): DomainErrorCode {
  const message = messageOf(error);

  // `CODE: detail` raised by our own functions.
  const prefix = message.split(':', 1)[0]?.trim() ?? '';
  if (DOMAIN_CODE_SET.has(prefix)) {
    return prefix as DomainErrorCode;
  }

  // Constraint violations raised by the schema rather than by a function.
  for (const [needle, code] of CONSTRAINT_CODES) {
    if (message.includes(needle)) {
      return code;
    }
  }

  return 'NOT_AUTHORIZED';
}

export function domainErrorFromDatabase(
  error: DatabaseErrorLike,
  fieldFor?: Partial<Record<DomainErrorCode, string>>,
): DomainError {
  const code = domainCodeFromDatabaseError(error);
  const field = fieldFor?.[code];

  return new DomainError(code, {
    cause: error,
    ...(field === undefined
      ? {}
      : { fieldErrors: { [field]: new DomainError(code).userMessage } }),
  });
}

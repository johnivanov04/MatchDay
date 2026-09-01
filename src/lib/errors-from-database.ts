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
 * fallback emits `action.dependency_failed`.
 *
 * ── ONE FAILURE IS NAMED, BECAUSE IT COST A PRODUCTION INCIDENT ────────────
 *
 * PostgREST answers `PGRST202` when the function a call names does not exist.
 * That happens for exactly one reason: application code is running against a
 * database that has not had its migrations applied. It is an operator error,
 * and it is not rare — Build #2 shipped to production while two migrations were
 * still pending, and every player who tapped "Enable phone notifications" was
 * told **"You do not have permission to do that."**
 *
 * That sentence sent the investigation into authorization, RLS and grants,
 * none of which were involved. So `PGRST202` now maps to
 * `SERVER_MISCONFIGURED`, whose copy says the fault is ours, and it logs the
 * *name of the missing function* — the one datum that turns a ten-minute hunt
 * into a one-line answer.
 *
 * Genuine authorization failures are untouched: they arrive as `AUTH_REQUIRED`
 * or `NOT_AUTHORIZED` from our own functions, or as SQLSTATE 42501, and still
 * classify exactly as before.
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

/** PostgREST's code for "the function you named is not in the schema cache". */
const MISSING_FUNCTION_CODE = 'PGRST202';

/**
 * The missing function's name, and nothing else.
 *
 * A deliberately narrow capture rather than logging the message. PostgREST's
 * text is `Could not find the function public.foo(a, b) in the schema cache`;
 * this takes `public.foo` and leaves the argument list, so no value a caller
 * supplied can ride along into the logs. Everything else in this module
 * discards the message for that reason and this does not weaken it.
 */
function missingFunctionName(message: string): string | null {
  return /could not find the function (public\.[a-z0-9_]+)/i.exec(message)?.[1] ?? null;
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
  /** False when the code was guessed rather than read. */
  recognised: boolean;
  /** True when an operator, not the caller, has to do something about it. */
  operatorWorthy: boolean;
  /** Present only for a missing function; see `missingFunctionName`. */
  missingFunction: string | null;
} {
  const message = messageOf(error);

  // `CODE: detail` raised by our own functions.
  const prefix = message.split(':', 1)[0]?.trim() ?? '';
  if (DOMAIN_CODE_SET.has(prefix)) {
    return { code: prefix as DomainErrorCode, recognised: true, operatorWorthy: false, missingFunction: null };
  }

  // The database is behind the code. Recognised — so the caller is told the
  // truth rather than that they lack permission — but still operator-worthy,
  // because nothing improves until somebody applies a migration.
  if (error.code === MISSING_FUNCTION_CODE) {
    return {
      code: 'SERVER_MISCONFIGURED',
      recognised: true,
      operatorWorthy: true,
      missingFunction: missingFunctionName(message),
    };
  }

  // Constraint violations raised by the schema rather than by a function.
  for (const [needle, code] of CONSTRAINT_CODES) {
    if (message.includes(needle)) {
      return { code, recognised: true, operatorWorthy: false, missingFunction: null };
    }
  }

  return { code: 'NOT_AUTHORIZED', recognised: false, operatorWorthy: true, missingFunction: null };
}

export function domainCodeFromDatabaseError(error: DatabaseErrorLike): DomainErrorCode {
  return classifyDatabaseError(error).code;
}

export function domainErrorFromDatabase(
  error: DatabaseErrorLike,
  fieldFor?: Partial<Record<DomainErrorCode, string>>,
): DomainError {
  const { code, recognised, operatorWorthy, missingFunction } = classifyDatabaseError(error);

  if (operatorWorthy) {
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
      // `false` for the catch-all, so the two cases can be told apart in a
      // dashboard without reading messages.
      recognised,
      // The whole point of naming this failure: an operator sees which function
      // is absent and knows immediately that a migration has not been applied.
      ...(missingFunction === null ? {} : { missingFunction }),
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

import 'server-only';

/**
 * Structured server logging.
 *
 * Before this, the server logged nothing at all: a failed action returned a
 * `DomainError` to the form and vanished, so "signups have been failing since
 * Tuesday" was not answerable from anything the deployment kept. Every hosting
 * platform this can run on collects stdout and indexes JSON lines, so one line
 * per event in a fixed shape is the whole mechanism — no agent, no vendor, no
 * dependency.
 *
 * ── WHAT MAY NEVER BE LOGGED ───────────────────────────────────────────────
 *
 * PRD §12 lists what must not leak, and application logs are read by more
 * people, retained longer and exported more freely than any screen in the
 * product. So the allowed shape is narrow *by type*, not by convention:
 * `LogFields` admits strings, numbers, booleans and null, and the writer
 * refuses anything whose key matches a forbidden name.
 *
 * Concretely, and deliberately, none of these ever reaches a log line:
 *
 *   * a phone number, gender, or any profile field beyond an opaque id
 *   * an attendance note, a disciplinary or membership-status reason, a
 *     cancellation reason, or an administrator's private note
 *   * a member's name, or the identity of anybody on a waitlist
 *   * a push endpoint, which is a bearer credential
 *   * a raw database error message, which can carry constraint names, column
 *     values and identifiers belonging to another tenant
 *
 * Ids are fine and are what makes a log useful: a league id and a match id let
 * an operator find the row, and finding the row is an authorized act with its
 * own audit trail. A name in a log is neither.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export type LogFields = Record<string, string | number | boolean | null | undefined>;

/**
 * Keys that must never appear, whatever the value.
 *
 * Matched as substrings against the lowercased key, so `cancellation_reason`,
 * `status_reason` and `reason` are all caught by one entry. A forbidden key is
 * dropped rather than the whole line, because losing the event entirely is a
 * worse outcome than losing one field.
 */
const FORBIDDEN_KEY_PARTS = [
  'reason',
  'note',
  'name',
  'email',
  'phone',
  'gender',
  'token',
  'secret',
  'password',
  'key',
  'endpoint',
  'auth',
  'message',
  'body',
  'title',
] as const;

function isForbidden(key: string): boolean {
  const lower = key.toLowerCase();
  return FORBIDDEN_KEY_PARTS.some((part) => lower.includes(part));
}

/** Caps a value so one pathological field cannot dominate a log budget. */
function safeValue(value: string | number | boolean | null | undefined): string | number | boolean | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value.length <= 200 ? value : `${value.slice(0, 199)}…`;
  }
  return value;
}

function write(level: LogLevel, event: string, fields: LogFields): void {
  const payload: Record<string, string | number | boolean | null> = {
    ts: new Date().toISOString(),
    level,
    event,
  };

  for (const [key, value] of Object.entries(fields)) {
    if (isForbidden(key)) {
      continue;
    }
    payload[key] = safeValue(value);
  }

  const line = JSON.stringify(payload);

  // `console.error` for warn and error so they reach stderr, which most
  // platforms route and alert on separately.
  if (level === 'info') {
    console.log(line);
  } else {
    console.error(line);
  }
}

export function logInfo(event: string, fields: LogFields = {}): void {
  write('info', event, fields);
}

export function logWarn(event: string, fields: LogFields = {}): void {
  write('warn', event, fields);
}

export function logError(event: string, fields: LogFields = {}): void {
  write('error', event, fields);
}

/**
 * Reduces an unknown thrown value to something loggable.
 *
 * The message is NOT included — see the header. What comes back is the error's
 * class and, for our own `DomainError`, its stable code, which is the part an
 * operator actually needs: `CAPACITY_EXCEEDED` appearing five hundred times in
 * an hour is a story, and the sentence attached to it is not.
 */
export function describeError(error: unknown): LogFields {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      error_name: error.name,
      error_code: typeof code === 'string' ? code : null,
    };
  }

  return { error_name: 'unknown', error_code: null };
}

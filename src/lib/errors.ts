import { describeError, logError, logInfo, logWarn } from '@/lib/observability/log';

/**
 * Stable domain error codes (02 §21). The full list is defined here even
 * though Phase 1 can only raise a subset, so later phases add behaviour rather
 * than renaming codes that clients may already handle.
 */
export const DOMAIN_ERROR_CODES = [
  'AUTH_REQUIRED',
  'PROFILE_INCOMPLETE',
  'LEAGUE_NOT_FOUND',
  'LEAGUE_PRIVATE',
  'MEMBERSHIP_REQUIRED',
  'MEMBERSHIP_INACTIVE',
  'JOIN_REQUEST_EXISTS',
  'NOT_LEAGUE_ADMIN',
  'ADMIN_TRANSFER_INVALID',
  'GUIDELINES_NOT_ACCEPTED',
  'MATCH_NOT_OPEN',
  'SIGNUP_CLOSED',
  'CAPACITY_EXCEEDED',
  'WAITLIST_CONFLICT',
  'ALREADY_CONFIRMED',
  'ALREADY_FINALIZED',
  'TEAM_ASSIGNMENT_INVALID',
  'NOTIFICATION_NOT_FOUND',
  'NOT_AUTHORIZED',
  'VALIDATION_FAILED',
  // Phase 2 additions. 02 §21 predates league creation, invitations and
  // discovery; these extend that list rather than renaming anything in it.
  'MEMBERSHIP_EXISTS',
  'INVITE_INVALID',
  'PROFILE_NOT_FOUND',
  'SLUG_TAKEN',
  // Phase 3B additions, for the two ways an edit can be refused.
  'MATCH_NOT_DRAFT',
  'MATCH_REVISION_STALE',
  // Phase 4. 02 §21 predates signup, so these extend the list rather than
  // renaming anything in it.
  'SIGNUP_MODE_MISMATCH',
  'SIGNUP_DECISION_INVALID',
  'SIGNUP_CANCELLATION_UNAVAILABLE',
  // Raised by the two lifecycle guard triggers rather than by a function.
  'MATCH_TRANSITION_INVALID',
  'SIGNUP_TRANSITION_INVALID',
  // Phase 7. Attendance and the administrator's membership decisions.
  'ATTENDANCE_NOT_OPEN',
  'ATTENDANCE_NOT_ELIGIBLE',
  'ATTENDANCE_OUTCOME_INVALID',
  'ATTENDANCE_REVISION_STALE',
  'ATTENDANCE_INCOMPLETE',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

/**
 * Messages safe to show a signed-in user.
 *
 * They are deliberately uninformative about *other* tenants: "not found" and
 * "not permitted" read the same from outside, so an error message cannot be
 * used to confirm that a league or membership exists.
 */
const USER_FACING_MESSAGES: Record<DomainErrorCode, string> = {
  AUTH_REQUIRED: 'Please sign in to continue.',
  PROFILE_INCOMPLETE: 'Finish setting up your profile to continue.',
  LEAGUE_NOT_FOUND: 'That league is not available.',
  LEAGUE_PRIVATE: 'That league is not available.',
  MEMBERSHIP_REQUIRED: 'You are not a member of that league.',
  MEMBERSHIP_INACTIVE: 'Your membership in that league is not active.',
  JOIN_REQUEST_EXISTS: 'You already have a pending request for that league.',
  NOT_LEAGUE_ADMIN: 'Only the league administrator can do that.',
  ADMIN_TRANSFER_INVALID: 'That administration transfer is not valid.',
  GUIDELINES_NOT_ACCEPTED: 'You need to accept this league’s guidelines first.',
  MATCH_NOT_OPEN: 'That match is not open.',
  SIGNUP_CLOSED: 'Signup for that match has closed.',
  CAPACITY_EXCEEDED: 'That match is already full.',
  WAITLIST_CONFLICT: 'The waitlist changed. Please try again.',
  ALREADY_CONFIRMED: 'You already have a confirmed spot.',
  ALREADY_FINALIZED: 'That roster has already been finalized.',
  TEAM_ASSIGNMENT_INVALID: 'That team assignment is not valid.',
  NOTIFICATION_NOT_FOUND: 'That notification is no longer available.',
  NOT_AUTHORIZED: 'You do not have permission to do that.',
  VALIDATION_FAILED: 'Please check the highlighted fields and try again.',
  MEMBERSHIP_EXISTS: 'You already belong to that league.',
  // Deliberately identical for a bad, expired, revoked or exhausted link: the
  // distinction would tell a probe that a private league exists.
  INVITE_INVALID: 'That invitation link is not valid or has expired.',
  PROFILE_NOT_FOUND: 'No Matchday account uses that email address.',
  SLUG_TAKEN: 'That league address is already taken.',
  MATCH_NOT_DRAFT: 'That match has been published, so it is edited a different way.',
  // Actionable on purpose: the fix is to reload, and saying so avoids somebody
  // resubmitting the same stale form repeatedly.
  MATCH_REVISION_STALE:
    'Somebody else changed this match while you were editing. Reload the page and try again.',
  MATCH_TRANSITION_INVALID: 'That match cannot move to that state.',
  SIGNUP_TRANSITION_INVALID: 'That signup change is not available yet.',
  SIGNUP_MODE_MISMATCH: 'That is not how this match fills its roster. Reload the page.',
  SIGNUP_DECISION_INVALID: 'That is not a decision you can record for this player.',
  // Says plainly that the feature does not exist rather than implying the
  // attempt failed. Cancelling a confirmed spot arrives with the rest of the
  // cancellation workflow — the cutoff labelling, the administrator alert and
  // the replacement — and doing the visible half early would leave a player
  // believing they were released when nobody had been told.
  SIGNUP_CANCELLATION_UNAVAILABLE:
    'Cancelling a confirmed spot is not available yet. Please contact your league administrator.',
  ATTENDANCE_NOT_OPEN: 'Attendance can be recorded once the match has finished.',
  ATTENDANCE_NOT_ELIGIBLE: 'That player was not confirmed for this match.',
  // Names the conflict rather than the rule, because the administrator can see
  // the player's status on the same screen and the two must agree.
  ATTENDANCE_OUTCOME_INVALID: 'That outcome does not match how this player left the match.',
  // Actionable, like MATCH_REVISION_STALE: the fix is to reload, and saying so
  // stops somebody resubmitting a decision that would overwrite one they never
  // saw.
  ATTENDANCE_REVISION_STALE:
    'Somebody else changed this player’s attendance while you were looking at it. Reload the page and try again.',
  ATTENDANCE_INCOMPLETE: 'Record an outcome for everybody before completing the match.',
};

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  /** Field-level messages, keyed by form field name. */
  readonly fieldErrors: Readonly<Record<string, string>>;

  constructor(
    code: DomainErrorCode,
    options?: { cause?: unknown; fieldErrors?: Record<string, string> },
  ) {
    super(code, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DomainError';
    this.code = code;
    this.fieldErrors = options?.fieldErrors ?? {};
  }

  get userMessage(): string {
    return USER_FACING_MESSAGES[this.code];
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

export function userMessageFor(code: DomainErrorCode): string {
  return USER_FACING_MESSAGES[code];
}

/** Result type used by server actions so a form can render an error without throwing. */
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; code: DomainErrorCode; message: string; fieldErrors: Record<string, string> };

export function actionSuccess(): ActionResult<undefined>;
export function actionSuccess<T>(data: T): ActionResult<T>;
export function actionSuccess<T>(data?: T): ActionResult<T | undefined> {
  return { ok: true, data };
}

/**
 * True for a Zod validation failure.
 *
 * Structural, not `instanceof`. `ZodError` is thrown across module and bundle
 * boundaries where a single class identity is not guaranteed, and this file is
 * reachable from client code, so importing Zod to narrow one branch would be a
 * runtime cost for a compile-time convenience.
 */
function isZodError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ZodError';
}

export function actionFailure(error: unknown): ActionResult<never> {
  if (isDomainError(error)) {
    // The stable code and nothing else. A refusal is usually the product
    // working — somebody tried to join a full match — so it is `info`, and its
    // value is in the aggregate: `CAPACITY_EXCEEDED` five hundred times in an
    // hour is a story worth reading.
    logInfo('action.refused', { code: error.code });

    return {
      ok: false,
      code: error.code,
      message: error.userMessage,
      fieldErrors: { ...error.fieldErrors },
    };
  }

  // ── Malformed input is not an incident ──────────────────────────────────
  //
  // Every action validates its form fields with Zod, and ~94 of those calls use
  // the throwing `.parse()` inside the try block. So a stale form, a bad UUID
  // or a hand-crafted POST lands here as a `ZodError`.
  //
  // That used to be logged as `action.failed` — the event documented as "the
  // one to alert on" — which made the alert both noisy and attacker-triggerable:
  // anybody can POST `league_id=x` to a server action and manufacture pages
  // indefinitely. It is an expected refusal that happens to arrive as an
  // exception rather than a `DomainError`, and it is classified as one here.
  //
  // Matched structurally on `name` rather than with `instanceof ZodError`: this
  // module is imported by client bundles for its types, and importing Zod here
  // purely to narrow a type would pull the library in for no runtime benefit.
  if (isZodError(error)) {
    logWarn('action.rejected_input', describeError(error));

    return {
      ok: false,
      code: 'NOT_AUTHORIZED',
      message: userMessageFor('NOT_AUTHORIZED'),
      fieldErrors: {},
    };
  }

  // Anything unrecognised is reported generically. Database and library
  // messages can name tables, constraints and other tenants' identifiers, and
  // none of that belongs in a client response — or in a log line, which is why
  // `describeError` returns the class and code and discards the message.
  //
  // THIS is the branch worth paging on: every expected refusal is either a
  // DomainError or a ZodError above, so reaching here means something threw
  // that nobody anticipated.
  //
  // `severity` is our own stable contract. A log drain filtering on it does not
  // depend on a library's class name, which would change silently under a major
  // version bump.
  logError('action.failed', { ...describeError(error), severity: 'unexpected' });

  return {
    ok: false,
    code: 'NOT_AUTHORIZED',
    message: userMessageFor('NOT_AUTHORIZED'),
    fieldErrors: {},
  };
}

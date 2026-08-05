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

export function actionFailure(error: unknown): ActionResult<never> {
  if (isDomainError(error)) {
    return {
      ok: false,
      code: error.code,
      message: error.userMessage,
      fieldErrors: { ...error.fieldErrors },
    };
  }

  // Anything unrecognised is reported generically. Database and library
  // messages can name tables, constraints and other tenants' identifiers, and
  // none of that belongs in a client response.
  return {
    ok: false,
    code: 'NOT_AUTHORIZED',
    message: userMessageFor('NOT_AUTHORIZED'),
    fieldErrors: {},
  };
}

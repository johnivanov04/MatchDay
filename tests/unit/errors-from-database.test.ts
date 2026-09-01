import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logError = vi.fn();
vi.mock('@/lib/observability/log', () => ({
  logError: (event: string, fields: unknown) => logError(event, fields),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const { domainCodeFromDatabaseError, domainErrorFromDatabase } = await import(
  '@/lib/errors-from-database'
);

/**
 * Classifying what the database said.
 *
 * The interesting case is the one that reached production. Build #2 deployed
 * while two migrations were still pending, so `register_apns_device` did not
 * exist; PostgREST answered `PGRST202`; the catch-all turned that into
 * `NOT_AUTHORIZED`; and every player who tapped "Enable phone notifications"
 * was told they lacked permission. The investigation went straight to RLS,
 * grants and roles — none of which were involved.
 */

/** Exactly what PostgREST returns for a function that is not in the schema cache. */
const MISSING_FUNCTION = {
  code: 'PGRST202',
  message:
    'Could not find the function public.register_apns_device(p_device_label, p_device_token, ' +
    'p_environment, p_installation_id) in the schema cache',
};

beforeEach(() => {
  logError.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('a function the database does not have', () => {
  it('is a server problem, not the caller’s', () => {
    expect(domainCodeFromDatabaseError(MISSING_FUNCTION)).toBe('SERVER_MISCONFIGURED');
  });

  it('no longer reports it as a permission failure', () => {
    // The regression, stated directly.
    expect(domainCodeFromDatabaseError(MISSING_FUNCTION)).not.toBe('NOT_AUTHORIZED');
  });

  it('tells the person it is our fault, without naming anything internal', () => {
    const message = domainErrorFromDatabase(MISSING_FUNCTION).userMessage;

    expect(message).toMatch(/on our side/i);
    expect(message).not.toMatch(/permission/i);
    // No database detail may reach a client.
    for (const leak of ['PGRST202', 'register_apns_device', 'public.', 'schema cache']) {
      expect(message).not.toContain(leak);
    }
  });

  it('logs the missing function so an operator knows a migration is unapplied', () => {
    domainErrorFromDatabase(MISSING_FUNCTION);

    expect(logError).toHaveBeenCalledTimes(1);
    const [event, fields] = logError.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('action.dependency_failed');
    expect(fields).toMatchObject({
      severity: 'unexpected',
      sqlstate: 'PGRST202',
      recognised: true,
      missingFunction: 'public.register_apns_device',
    });
  });

  it('logs the function name and nothing the caller supplied', () => {
    /**
     * The capture is narrow on purpose. PostgREST puts the argument list in the
     * same sentence, and this module discards messages precisely because they
     * can carry values belonging to somebody else.
     */
    domainErrorFromDatabase({
      code: 'PGRST202',
      message:
        'Could not find the function public.some_fn(p_secret_value, p_email) in the schema cache',
    });

    const [, fields] = logError.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields.missingFunction).toBe('public.some_fn');
    const serialised = JSON.stringify(fields);
    expect(serialised).not.toContain('p_secret_value');
    expect(serialised).not.toContain('p_email');
  });

  it('still classifies when the message shape is unfamiliar', () => {
    const error = { code: 'PGRST202', message: 'something PostgREST worded differently' };

    expect(domainCodeFromDatabaseError(error)).toBe('SERVER_MISCONFIGURED');
    domainErrorFromDatabase(error);
    const [, fields] = logError.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields).not.toHaveProperty('missingFunction');
  });
});

describe('genuine authorization failures are untouched', () => {
  it.each([
    ['NOT_AUTHORIZED: no such device', 'NOT_AUTHORIZED'],
    ['AUTH_REQUIRED: no authenticated session', 'AUTH_REQUIRED'],
    ['NOT_LEAGUE_ADMIN: only the administrator may do that', 'NOT_LEAGUE_ADMIN'],
    ['MEMBERSHIP_REQUIRED: not a member', 'MEMBERSHIP_REQUIRED'],
  ])('%s maps to %s', (message, expected) => {
    expect(domainCodeFromDatabaseError({ code: '42501', message })).toBe(expected);
  });

  it('does not log a permission refusal as an operator problem', () => {
    // These are ordinary outcomes. Paging on them is how a real alert gets
    // ignored.
    domainErrorFromDatabase({ code: '42501', message: 'NOT_AUTHORIZED: no such device' });
    expect(logError).not.toHaveBeenCalled();
  });
});

describe('the catch-all still exists', () => {
  it('falls back to NOT_AUTHORIZED for a genuinely unknown error', () => {
    // A lost connection, a statement timeout, a constraint nobody has modelled.
    expect(domainCodeFromDatabaseError({ code: '57014', message: 'canceling statement' })).toBe(
      'NOT_AUTHORIZED',
    );
  });

  it('reports the fallback as unrecognised, so the two cases are separable', () => {
    domainErrorFromDatabase({ code: '57014', message: 'canceling statement due to timeout' });

    const [event, fields] = logError.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('action.dependency_failed');
    expect(fields).toMatchObject({ recognised: false, sqlstate: '57014' });
    // The message can carry another tenant's data and is still never logged.
    expect(JSON.stringify(fields)).not.toContain('canceling statement');
  });
});

describe('constraint violations keep their clearer meaning', () => {
  it.each([
    ['duplicate key value violates unique constraint "leagues_slug_key"', 'SLUG_TAKEN'],
    [
      'duplicate key value violates unique constraint "league_memberships_league_user_key"',
      'MEMBERSHIP_EXISTS',
    ],
  ])('%s → %s', (message, expected) => {
    expect(domainCodeFromDatabaseError({ code: '23505', message })).toBe(expected);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ObservabilityLog from '@/lib/observability/log';
import { z } from 'zod';

/**
 * How a failure is classified for alerting.
 *
 * ── THE PROBLEM THIS FIXES ─────────────────────────────────────────────────
 *
 * `action.failed` was documented as "the one to alert on" and was wrong in both
 * directions:
 *
 *   * **too loud** — every `.parse()` inside an action's try block throws a
 *     `ZodError` on malformed input, and there are ~94 of them. Anybody could
 *     POST `league_id=x` and manufacture pages at will;
 *   * **too quiet** — a lost connection or unknown constraint fell through
 *     `domainCodeFromDatabaseError`'s catch-all into an ordinary `DomainError`,
 *     logged as `action.refused` at *info*. The outage was the quietest line in
 *     the logs.
 *
 * These tests pin the three-way split. They also pin that **nothing
 * user-visible changed** — this is a logging change, and an `ActionResult` that
 * shifted would be a regression dressed up as observability.
 */

const mocks = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

// The writers are spied on; everything else keeps its real implementation, so
// `assertLoggable` checks keys against the actual filter rather than a stand-in.
vi.mock('@/lib/observability/log', async (importOriginal) => ({
  ...(await importOriginal<typeof ObservabilityLog>()),
  logInfo: mocks.logInfo,
  logWarn: mocks.logWarn,
  logError: mocks.logError,
}));

const { actionFailure, DomainError } = await import('@/lib/errors');
const { domainErrorFromDatabase, domainCodeFromDatabaseError } = await import(
  '@/lib/errors-from-database'
);
const { assertLoggable } = await import('@/lib/observability/log');

/** Every event name emitted during the current test. */
function emittedEvents(): string[] {
  return [
    ...mocks.logInfo.mock.calls,
    ...mocks.logWarn.mock.calls,
    ...mocks.logError.mock.calls,
  ].map(([event]) => String(event));
}

/** Everything logged, flattened, for leak scanning. */
function loggedText(): string {
  return JSON.stringify([
    ...mocks.logInfo.mock.calls,
    ...mocks.logWarn.mock.calls,
    ...mocks.logError.mock.calls,
  ]);
}

function fieldsFor(event: string): Record<string, unknown> {
  const call = [
    ...mocks.logInfo.mock.calls,
    ...mocks.logWarn.mock.calls,
    ...mocks.logError.mock.calls,
  ].find(([name]) => name === event);
  return (call?.[1] ?? {}) as Record<string, unknown>;
}

/** A real ZodError, produced the way an action produces one. */
function zodError(): unknown {
  try {
    z.uuid().parse('not-a-uuid');
    throw new Error('expected a ZodError');
  } catch (error: unknown) {
    return error;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('malformed input is not an incident', () => {
  it('emits action.rejected_input for a ZodError', async () => {
    actionFailure(zodError());

    expect(emittedEvents()).toContain('action.rejected_input');
  });

  it('never emits action.failed for a ZodError', async () => {
    actionFailure(zodError());

    // This is the assertion that stops an attacker manufacturing pages.
    expect(emittedEvents()).not.toContain('action.failed');
  });

  it('holds for every schema an action actually uses', () => {
    const schemas = [
      () => z.uuid().parse('nope'),
      () => z.string().min(5).parse('a'),
      () => z.enum(['a', 'b']).parse('c'),
      () => z.coerce.number().int().parse('abc'),
    ];

    for (const [index, throwing] of schemas.entries()) {
      vi.clearAllMocks();
      try {
        throwing();
      } catch (error: unknown) {
        actionFailure(error);
      }
      expect(emittedEvents(), `schema ${String(index)}`).not.toContain('action.failed');
      expect(emittedEvents(), `schema ${String(index)}`).toContain('action.rejected_input');
    }
  });
});

describe('genuine unexpected failures still page', () => {
  it('emits action.failed with severity unexpected for a TypeError', () => {
    actionFailure(new TypeError('cannot read property of undefined'));

    expect(emittedEvents()).toContain('action.failed');
    expect(fieldsFor('action.failed')).toMatchObject({
      severity: 'unexpected',
      error_type: 'TypeError',
    });
  });

  it('emits action.failed for a thrown non-Error', () => {
    actionFailure('a bare string was thrown');

    expect(emittedEvents()).toContain('action.failed');
    expect(fieldsFor('action.failed')).toMatchObject({ severity: 'unexpected' });
  });

  it('does not emit action.rejected_input for a genuine failure', () => {
    actionFailure(new RangeError('out of range'));

    expect(emittedEvents()).not.toContain('action.rejected_input');
  });
});

describe('domain refusals are unchanged', () => {
  it('still emits action.refused at info', () => {
    actionFailure(new DomainError('CAPACITY_EXCEEDED'));

    expect(mocks.logInfo).toHaveBeenCalledWith('action.refused', { code: 'CAPACITY_EXCEEDED' });
    expect(emittedEvents()).not.toContain('action.failed');
    expect(emittedEvents()).not.toContain('action.rejected_input');
  });

  it('carries no severity, because a refusal is not a severity question', () => {
    actionFailure(new DomainError('SIGNUP_CLOSED'));

    expect(fieldsFor('action.refused')).toEqual({ code: 'SIGNUP_CLOSED' });
  });
});

describe('the user-visible result is byte-identical to before', () => {
  const generic = {
    ok: false,
    code: 'NOT_AUTHORIZED',
    message: 'You do not have permission to do that.',
    fieldErrors: {},
  };

  it('returns the generic result for a ZodError, exactly as it always did', () => {
    // The classification changed; what the player sees did not.
    expect(actionFailure(zodError())).toEqual(generic);
  });

  it('returns the generic result for an unexpected failure', () => {
    expect(actionFailure(new TypeError('boom'))).toEqual(generic);
  });

  it('returns the domain error result unchanged', () => {
    const result = actionFailure(
      new DomainError('CAPACITY_EXCEEDED', { fieldErrors: { form: 'Full.' } }),
    );

    expect(result).toEqual({
      ok: false,
      code: 'CAPACITY_EXCEEDED',
      message: 'That match is already full.',
      fieldErrors: { form: 'Full.' },
    });
  });

  it('gives a ZodError and a TypeError the same result, so no new signal leaks', () => {
    // A caller must not be able to tell malformed input from an internal fault
    // — that distinction is for our logs, not for a response.
    expect(actionFailure(zodError())).toEqual(actionFailure(new TypeError('boom')));
  });
});

describe('unrecognised database errors are operator-worthy', () => {
  it('emits action.dependency_failed when the catch-all fires', () => {
    domainErrorFromDatabase({ message: 'could not connect to server', code: '08006' });

    expect(emittedEvents()).toContain('action.dependency_failed');
    expect(fieldsFor('action.dependency_failed')).toMatchObject({
      severity: 'unexpected',
      sqlstate: '08006',
    });
  });

  it('does not emit it for a recognised domain code', () => {
    domainErrorFromDatabase({ message: 'CAPACITY_EXCEEDED: this match is already full' });

    expect(emittedEvents()).not.toContain('action.dependency_failed');
  });

  it('does not emit it for a recognised constraint', () => {
    domainErrorFromDatabase({ message: 'duplicate key value violates leagues_slug_key' });

    expect(emittedEvents()).not.toContain('action.dependency_failed');
  });

  it('reports a null sqlstate rather than inventing one', () => {
    domainErrorFromDatabase({ message: 'something the app does not model' });

    expect(fieldsFor('action.dependency_failed')['sqlstate']).toBeNull();
  });

  it('leaves the returned DomainError and user message unchanged', () => {
    const error = domainErrorFromDatabase({ message: 'could not connect to server' });

    // Classification only: the client still sees the least informative outcome.
    expect(error.code).toBe('NOT_AUTHORIZED');
    expect(error.userMessage).toBe('You do not have permission to do that.');
  });

  it('leaves recognised mapping behaviour untouched', () => {
    expect(
      domainCodeFromDatabaseError({ message: 'CAPACITY_EXCEEDED: full' }),
    ).toBe('CAPACITY_EXCEEDED');
    expect(
      domainCodeFromDatabaseError({ message: 'violates leagues_slug_key' }),
    ).toBe('SLUG_TAKEN');
    expect(domainCodeFromDatabaseError({ message: 'unknown' })).toBe('NOT_AUTHORIZED');
  });
});

describe('nothing sensitive reaches the new events', () => {
  it('never logs the database message, constraint name or identifiers', () => {
    domainErrorFromDatabase({
      message:
        'duplicate key value violates unique constraint "some_table_pkey" for league rmvfc (user alice@example.org)',
      code: '23505',
    });

    const logged = loggedText();
    for (const secret of ['rmvfc', 'alice@example.org', 'some_table_pkey', 'duplicate key']) {
      expect(logged, secret).not.toContain(secret);
    }
    // The SQLSTATE is the useful, non-identifying part.
    expect(logged).toContain('23505');
  });

  it('never logs the Zod issue text, which quotes the submitted value', () => {
    try {
      z.string().min(5).parse('secret-value-xyz');
    } catch (error: unknown) {
      actionFailure(error);
    }

    expect(loggedText()).not.toContain('secret-value-xyz');
  });

  it('never logs an unexpected error message', () => {
    actionFailure(new Error('connection to db.abc123.supabase.co refused for user postgres'));

    expect(loggedText()).not.toContain('supabase.co');
    expect(loggedText()).not.toContain('postgres');
  });
});

describe('every new field survives the log-field filter', () => {
  it('emits only loggable keys across all three classifications', () => {
    actionFailure(zodError());
    actionFailure(new TypeError('boom'));
    actionFailure(new DomainError('CAPACITY_EXCEEDED'));
    domainErrorFromDatabase({ message: 'unmodelled', code: '08006' });

    const calls = [
      ...mocks.logInfo.mock.calls,
      ...mocks.logWarn.mock.calls,
      ...mocks.logError.mock.calls,
    ];
    expect(calls.length).toBeGreaterThan(0);

    for (const [event, fields] of calls) {
      // `severity` and `sqlstate` must not collide with the denylist — a
      // silently dropped field is this module's characteristic failure mode.
      expect(assertLoggable(fields as ObservabilityLog.LogFields), String(event)).toBe(true);
    }
  });

  it('keeps severity present on the paging events specifically', () => {
    actionFailure(new TypeError('boom'));
    domainErrorFromDatabase({ message: 'unmodelled' });

    expect(fieldsFor('action.failed')['severity']).toBe('unexpected');
    expect(fieldsFor('action.dependency_failed')['severity']).toBe('unexpected');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertLoggable,
  describeError,
  logError,
  logInfo,
  logWarn,
} from '@/lib/observability/log';
import { DomainError } from '@/lib/errors';

/**
 * The logger's two jobs, which pull against each other.
 *
 * It must never write personal data, and it must actually write the operational
 * fields it is given. The filter is a substring match on the key, which is
 * blunt on purpose — and blunt in both directions. `error_name` was silently
 * dropped for containing `name`, so `action.failed`, the event most worth
 * alerting on, recorded nothing but a null code.
 */

function captured(fn: () => void): Record<string, unknown> {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  fn();
  const line = (spy.mock.calls[0]?.[0] ?? out.mock.calls[0]?.[0]) as string;
  spy.mockRestore();
  out.mockRestore();
  return JSON.parse(line) as Record<string, unknown>;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('personal data never reaches a line', () => {
  it('drops every forbidden key', () => {
    const payload = captured(() => {
      logInfo('probe', {
        first_name: 'Alice',
        last_name: 'Smith',
        email: 'alice@example.org',
        phone: '+15550100',
        gender: 'female',
        cancellation_reason: 'Injured',
        attendance_note: 'Told the group chat',
        status_reason: 'Abusive language',
        match_title: 'Thursday 5v5',
        push_endpoint: 'https://fcm.example/abc',
        auth_token: 'secret-value',
        api_key: 'sk-live-1',
        error_message: 'duplicate key violates leagues_slug_key',
        response_body: '{}',
      });
    });

    expect(Object.keys(payload).sort()).toEqual(['event', 'level', 'ts']);
    expect(JSON.stringify(payload)).not.toContain('Alice');
    expect(JSON.stringify(payload)).not.toContain('Injured');
  });

  it('keeps identifiers, which are what make a log useful', () => {
    const payload = captured(() => {
      logInfo('probe', { league_id: 'abc', match_id: 'def', claimed: 2 });
    });

    expect(payload).toMatchObject({ league_id: 'abc', match_id: 'def', claimed: 2 });
  });

  it('truncates a pathological value rather than dropping the line', () => {
    const payload = captured(() => {
      logInfo('probe', { detail: 'x'.repeat(500) });
    });

    expect(String(payload['detail']).length).toBeLessThanOrEqual(200);
  });
});

describe('operational fields are not silently dropped', () => {
  it('writes the error class for an unexpected failure', () => {
    // REGRESSION: this used to be `error_name`, which the filter ate for
    // containing `name`. `action.failed` logged `{"error_code": null}` — no
    // indication of what had actually gone wrong.
    const payload = captured(() => {
      logError('action.failed', describeError(new TypeError('boom')));
    });

    expect(payload['error_type']).toBe('TypeError');
  });

  it('writes the stable code for a DomainError', () => {
    const payload = captured(() => {
      logError('action.failed', describeError(new DomainError('CAPACITY_EXCEEDED')));
    });

    expect(payload).toMatchObject({ error_type: 'DomainError', error_code: 'CAPACITY_EXCEEDED' });
  });

  it('still never writes the error message', () => {
    const payload = captured(() => {
      logError(
        'action.failed',
        describeError(new Error('duplicate key value violates "leagues_slug_key" (rmvfc)')),
      );
    });

    expect(JSON.stringify(payload)).not.toContain('rmvfc');
    expect(JSON.stringify(payload)).not.toContain('leagues_slug_key');
  });

  it('handles a thrown non-Error', () => {
    const payload = captured(() => {
      logError('action.failed', describeError('a string was thrown'));
    });

    expect(payload).toMatchObject({ error_type: 'unknown', error_code: null });
    expect(JSON.stringify(payload)).not.toContain('a string was thrown');
  });
});

describe('assertLoggable', () => {
  it('is true for the fields every current event emits', () => {
    expect(assertLoggable(describeError(new Error('x')))).toBe(true);
    expect(assertLoggable({ claimed: 1, notified: 2, push_failures: 0 })).toBe(true);
    expect(assertLoggable({ service_role_configured: false })).toBe(true);
    expect(assertLoggable({ code: 'CAPACITY_EXCEEDED' })).toBe(true);
  });

  it('is false for a key the filter would eat, so a test can catch it', () => {
    expect(assertLoggable({ error_name: 'TypeError' })).toBe(false);
    expect(assertLoggable({ reason: 'anything' })).toBe(false);
    expect(assertLoggable({ endpoint_count: 3 })).toBe(false);
  });
});

describe('levels reach the right stream', () => {
  it('sends info to stdout and warn/error to stderr', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    logInfo('a');
    logWarn('b');
    logError('c');

    // Most platforms route and alert on stderr separately.
    expect(out).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it } from 'vitest';
import { classifyEmailError, classifyEmailStatusCode } from '@/lib/email/classify';

/**
 * A provider's answer, turned into something the queue can act on.
 *
 * The vocabulary is Phase 3C's on purpose: a job with a push channel and an
 * email channel must be reasoned about with one rule, not two state machines
 * that drift apart.
 */

describe('retryable', () => {
  it.each([[429], [500], [502], [503], [504], [599]])('%i is a temporary failure', (status) => {
    expect(classifyEmailStatusCode(status).status).toBe('temporary_failure');
  });

  it('names rate limiting specifically, because it is the common one', () => {
    expect(classifyEmailStatusCode(429)).toEqual({
      status: 'temporary_failure',
      category: 'rate_limited',
    });
  });

  it.each([
    ['TimeoutError', 'timeout'],
    ['AbortError', 'timeout'],
  ])('%s is a temporary failure', (name, category) => {
    const error = Object.assign(new Error('slow'), { name });
    expect(classifyEmailError(error)).toEqual({ status: 'temporary_failure', category });
  });

  it('a plain network fault is a temporary failure', () => {
    expect(classifyEmailError(new Error('ECONNRESET'))).toEqual({
      status: 'temporary_failure',
      category: 'network',
    });
  });

  it('a thrown non-error is still classified rather than crashing', () => {
    expect(classifyEmailError('a string was thrown').status).toBe('temporary_failure');
    expect(classifyEmailError(null).status).toBe('temporary_failure');
  });
});

describe('permanent', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
  ])('%i is a permanent failure (%s)', (status, category) => {
    // OPERATOR-WORTHY. A missing, revoked or wrong API key, or an unverified
    // sending domain. Every retry burns budget to be told the same thing, and
    // the fix is a person changing configuration.
    expect(classifyEmailStatusCode(status)).toEqual({ status: 'permanent_failure', category });
  });

  it.each([
    [400, 'invalid_request'],
    [422, 'invalid_request'],
    [404, 'not_found'],
    [413, 'payload_too_large'],
    [418, 'rejected'],
  ])('%i is a permanent failure (%s)', (status, category) => {
    expect(classifyEmailStatusCode(status)).toEqual({ status: 'permanent_failure', category });
  });

  it('never marks a configuration problem retryable', () => {
    // The regression that would matter: a deployment with a bad key retrying
    // every notification five times, for ever.
    for (const status of [400, 401, 403, 404, 413, 422]) {
      expect(classifyEmailStatusCode(status).status).toBe('permanent_failure');
    }
  });
});

describe('every category fits the database constraint', () => {
  it('is lower snake case, 3 to 40 characters', () => {
    const shape = /^[a-z][a-z0-9_]{2,39}$/;
    const statuses = [400, 401, 403, 404, 413, 418, 422, 429, 500, 503];

    for (const status of statuses) {
      expect(classifyEmailStatusCode(status).category, String(status)).toMatch(shape);
    }
    for (const error of [Object.assign(new Error('x'), { name: 'TimeoutError' }), new Error('y')]) {
      expect(classifyEmailError(error).category).toMatch(shape);
    }
  });
});

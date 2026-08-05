import { describe, expect, it } from 'vitest';
import { classifyPushError, classifyPushStatusCode } from '@/lib/push/classify';

/**
 * Two decisions come out of every failed send, and conflating them is how push
 * systems end up hammering dead endpoints forever or dropping every alert after
 * one blip: is it worth retrying, and is the subscription still real?
 */
describe('classifyPushStatusCode', () => {
  describe('the subscription is gone', () => {
    it.each([404, 410])('invalidates on %i', (status) => {
      const result = classifyPushStatusCode(status);
      expect(result.status).toBe('invalidated');
      expect(result.invalidatesSubscription).toBe(true);
    });
  });

  describe('permanent, but the subscription is fine', () => {
    it.each([400, 401, 403])('treats %i as unauthorized and permanent', (status) => {
      const result = classifyPushStatusCode(status);
      // Wrong VAPID credentials need an operator, not a queue.
      expect(result.status).toBe('permanent_failure');
      expect(result.category).toBe('unauthorized');
      expect(result.invalidatesSubscription).toBe(false);
    });

    it('treats 413 as a payload problem', () => {
      const result = classifyPushStatusCode(413);
      expect(result.status).toBe('permanent_failure');
      expect(result.category).toBe('payload_too_large');
    });
  });

  describe('worth retrying', () => {
    it('treats 429 as rate limiting', () => {
      const result = classifyPushStatusCode(429);
      expect(result.status).toBe('temporary_failure');
      expect(result.category).toBe('rate_limited');
    });

    it.each([500, 502, 503, 504])('treats %i as a server error', (status) => {
      const result = classifyPushStatusCode(status);
      expect(result.status).toBe('temporary_failure');
      expect(result.category).toBe('server_error');
    });

    it('falls back to temporary for an unrecognised status', () => {
      // The safer default: retrying a doomed message wastes a little work,
      // whereas discarding a deliverable one loses a match alert.
      const result = classifyPushStatusCode(418);
      expect(result.status).toBe('temporary_failure');
      expect(result.category).toBe('unknown');
    });
  });

  it('never invalidates for anything except 404 and 410', () => {
    for (const status of [400, 401, 403, 413, 429, 500, 502, 503, 504, 418]) {
      expect(classifyPushStatusCode(status).invalidatesSubscription).toBe(false);
    }
  });
});

describe('classifyPushError', () => {
  it('uses the status code when the error carries one', () => {
    const result = classifyPushError({ statusCode: 410 });
    expect(result.status).toBe('invalidated');
    expect(result.category).toBe('gone');
  });

  it.each(['AbortError', 'TimeoutError'])('treats %s as a timeout', (name) => {
    const result = classifyPushError(Object.assign(new Error('x'), { name }));
    expect(result.status).toBe('temporary_failure');
    expect(result.category).toBe('timeout');
  });

  it('treats an unknown error as a temporary network problem', () => {
    const result = classifyPushError(new Error('socket hang up'));
    expect(result.status).toBe('temporary_failure');
    expect(result.category).toBe('network');
  });

  it('survives a non-error value', () => {
    for (const value of [null, undefined, 'boom', 42]) {
      expect(classifyPushError(value).status).toBe('temporary_failure');
    }
  });

  it('never lets the error text become the stored category', () => {
    // `web-push` errors embed the endpoint, which is a bearer credential.
    // Only the shape of the error is inspected, never its message.
    const leaky = Object.assign(
      new Error('Received unexpected response from https://push.example/secret-endpoint'),
      { name: 'WebPushError' },
    );

    const result = classifyPushError(leaky);
    expect(result.category).toBe('network');
    expect(result.category).not.toContain('push.example');
    expect(JSON.stringify(result)).not.toContain('secret-endpoint');
  });

  it('produces only categories the database column accepts', () => {
    // `push_delivery_attempts_error_category_shape` is `^[a-z][a-z0-9_]{2,39}$`.
    const categories = [
      ...[404, 410, 400, 413, 429, 500, 418].map((s) => classifyPushStatusCode(s).category),
      classifyPushError(new Error('x')).category,
      classifyPushError(Object.assign(new Error('x'), { name: 'TimeoutError' })).category,
    ];

    for (const category of categories) {
      expect(category).toMatch(/^[a-z][a-z0-9_]{2,39}$/);
    }
  });
});

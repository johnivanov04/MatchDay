import { describe, expect, it } from 'vitest';
import { classifyApnsFailure, classifyPushError, classifyPushStatusCode } from '@/lib/push/classify';

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

describe('classifyApnsFailure', () => {
  /**
   * The reason decides, not the status. This is the whole point of the
   * function: `403` alone covers five different conditions, none of which say
   * anything about the device.
   */

  describe('retires the device', () => {
    /**
     * The complete list. Retiring a registration is invisible to the player and
     * cannot be undone without them finding the setting again, so the bar is
     * that the token itself is dead — not that a send failed.
     */
    it.each([
      ['Unregistered', 410, 'gone', 'the app was deleted from the device'],
      ['ExpiredToken', 410, 'gone', 'likewise'],
      ['BadDeviceToken', 400, 'bad_device_token', 'APNs will not accept this token'],
    ])('%s → invalidated (%s)', (reason, status, category) => {
      expect(classifyApnsFailure(status, reason)).toEqual({
        status: 'invalidated',
        category,
        invalidatesSubscription: true,
      });
    });

    it('retires on nothing else', () => {
      // Stated as an exhaustive check rather than a list, so a reason added to
      // the invalidating branch without thought fails here.
      const retiring = [
        'Unregistered',
        'ExpiredToken',
        'BadDeviceToken',
        'DeviceTokenNotForTopic',
        'ExpiredProviderToken',
        'InvalidProviderToken',
        'MissingProviderToken',
        'BadCertificate',
        'BadCertificateEnvironment',
        'BadTopic',
        'TopicDisallowed',
        'MissingTopic',
        'MissingDeviceToken',
        'BadPath',
        'MethodNotAllowed',
        'BadPriority',
        'BadExpirationDate',
        'BadMessageId',
        'BadCollapseId',
        'DuplicateHeaders',
        'InvalidPushType',
        'PayloadEmpty',
        'PayloadTooLarge',
        'TooManyRequests',
        'TooManyProviderTokenUpdates',
        'IdleTimeout',
        'InternalServerError',
        'ServiceUnavailable',
        'Shutdown',
        'SomethingAppleAddedLastTuesday',
        null,
      ].filter((reason) => classifyApnsFailure(400, reason).invalidatesSubscription);

      expect(retiring).toEqual(['Unregistered', 'ExpiredToken', 'BadDeviceToken']);
    });
  });

  describe('DeviceTokenNotForTopic keeps the registration', () => {
    /**
     * It reads like a device problem and is not one. It says the token does not
     * belong to the topic the request claimed — and the topic is
     * `APNS_BUNDLE_ID`, so a wrong bundle identifier, a key issued for another
     * app, and an upstream environment mismatch all produce it. Retiring on it
     * would empty the device table over one wrong environment variable.
     */
    it('is a permanent failure that leaves the subscription enabled', () => {
      expect(classifyApnsFailure(400, 'DeviceTokenNotForTopic')).toEqual({
        status: 'permanent_failure',
        category: 'provider_config',
        invalidatesSubscription: false,
      });
    });

    it('is recorded in a state record_push_delivery_result does not act on', () => {
      // `permanent_failure` has no branch in that function: the row is left
      // exactly as it was, so delivery resumes the moment the configuration is
      // corrected, with nobody re-enabling anything.
      expect(classifyApnsFailure(400, 'DeviceTokenNotForTopic').status).toBe('permanent_failure');
    });
  });

  describe('leaves the device alone when the fault is ours', () => {
    /**
     * The failure mode this guards against is severe and silent: a signing key
     * expires, every send returns 403, and a status-driven classifier retires
     * every device in the database. Players would have to notice notifications
     * had stopped and re-enable them by hand, one phone at a time.
     *
     * `record_push_delivery_result` has no branch for `permanent_failure`, so a
     * row classified this way is left untouched and starts working again the
     * moment the key is replaced.
     */
    it.each([
      ['ExpiredProviderToken', 403],
      ['InvalidProviderToken', 403],
      ['MissingProviderToken', 401],
      ['BadCertificate', 403],
      ['BadCertificateEnvironment', 403],
    ])('%s is a permanent failure that does not invalidate', (reason, status) => {
      expect(classifyApnsFailure(status, reason)).toEqual({
        status: 'permanent_failure',
        category: 'unauthorized',
        invalidatesSubscription: false,
      });
    });

    it.each([
      ['DeviceTokenNotForTopic'],
      ['BadTopic'],
      ['TopicDisallowed'],
      ['MissingTopic'],
      ['BadPath'],
      ['MethodNotAllowed'],
      ['BadPriority'],
      ['BadExpirationDate'],
      ['InvalidPushType'],
      ['DuplicateHeaders'],
      ['PayloadEmpty'],
    ])('%s is a request we built wrong, not a device that is gone', (reason) => {
      expect(classifyApnsFailure(400, reason)).toMatchObject({
        status: 'permanent_failure',
        category: 'provider_config',
        invalidatesSubscription: false,
      });
    });

    it('does not retire a device merely because the status was 403', () => {
      // Stated separately because it is the specific mistake being avoided.
      expect(classifyApnsFailure(403, 'ExpiredProviderToken').invalidatesSubscription).toBe(false);
      expect(classifyApnsFailure(403, null).invalidatesSubscription).toBe(false);
    });
  });

  describe('retries', () => {
    it.each([
      ['TooManyRequests', 429, 'rate_limited'],
      // Means we regenerated the signing JWT too often. The fix is the cache in
      // `apns.ts`, not to stop sending.
      ['TooManyProviderTokenUpdates', 429, 'rate_limited'],
      ['IdleTimeout', 400, 'timeout'],
      ['InternalServerError', 500, 'server_error'],
      ['ServiceUnavailable', 503, 'server_error'],
      ['Shutdown', 503, 'server_error'],
    ])('%s → temporary (%s)', (reason, status, category) => {
      expect(classifyApnsFailure(status, reason)).toEqual({
        status: 'temporary_failure',
        category,
        invalidatesSubscription: false,
      });
    });
  });

  describe('an unrecognised reason', () => {
    it('is temporary, never fatal to the device', () => {
      // Apple adds reasons. Retrying something hopeless wastes a little work;
      // permanently discarding something recoverable loses a match alert, and
      // retiring a device on a reason nobody has read yet is worse than both.
      expect(classifyApnsFailure(400, 'SomethingAppleAddedLastTuesday')).toEqual({
        status: 'temporary_failure',
        category: 'unknown',
        invalidatesSubscription: false,
      });
    });

    it('still falls back to what the status can say', () => {
      expect(classifyApnsFailure(503, null)).toMatchObject({ category: 'server_error' });
      expect(classifyApnsFailure(429, null)).toMatchObject({ category: 'rate_limited' });
    });
  });

  it('produces a category the delivery table will accept', () => {
    // `push_delivery_attempts_error_category_shape` is `^[a-z][a-z0-9_]{2,39}$`.
    // A category that violates it turns a recorded failure into a crash inside
    // the recorder.
    for (const reason of [
      'Unregistered',
      'ExpiredToken',
      'BadDeviceToken',
      'DeviceTokenNotForTopic',
      'ExpiredProviderToken',
      'BadTopic',
      'PayloadTooLarge',
      'TooManyRequests',
      'InternalServerError',
      'Unknown',
      null,
    ]) {
      expect(classifyApnsFailure(400, reason).category).toMatch(/^[a-z][a-z0-9_]{2,39}$/);
    }
  });
});

import type { PushDeliveryStatus } from '@/types/database';

/**
 * Turning a push-service failure into something worth storing.
 *
 * Two decisions come out of every failed send, and conflating them is how push
 * systems end up either hammering dead endpoints forever or quietly dropping
 * every alert after one network blip:
 *
 *   * **Is it worth retrying?** A 503 is; a malformed VAPID key never will be.
 *   * **Is the subscription still real?** A 404 or 410 means the browser threw
 *     it away, and the row should stop being used.
 *
 * Only the resulting category is persisted. The provider's response body and
 * headers can contain the endpoint itself, which is a bearer credential, so
 * they are never written to a table or an audit event.
 */

export type PushErrorCategory =
  | 'gone'
  | 'not_found'
  | 'unauthorized'
  | 'payload_too_large'
  | 'rate_limited'
  | 'server_error'
  | 'network'
  | 'timeout'
  | 'unknown';

export interface PushFailureClassification {
  status: Extract<
    PushDeliveryStatus,
    'temporary_failure' | 'permanent_failure' | 'invalidated'
  >;
  category: PushErrorCategory;
  /** True when the subscription itself should be retired. */
  invalidatesSubscription: boolean;
}

/**
 * Classifies by HTTP status code from the push service (RFC 8030).
 *
 * An unrecognised status is treated as temporary. That is the safer default:
 * retrying a message that will never succeed wastes a little work, whereas
 * permanently discarding one that would have succeeded loses a match alert.
 */
export function classifyPushStatusCode(statusCode: number): PushFailureClassification {
  // The browser has discarded this subscription. It will never work again.
  if (statusCode === 404 || statusCode === 410) {
    return {
      status: 'invalidated',
      category: statusCode === 404 ? 'not_found' : 'gone',
      invalidatesSubscription: true,
    };
  }

  // Our VAPID credentials are wrong or the endpoint rejects us. Retrying with
  // the same keys cannot help; this needs an operator, not a queue.
  if (statusCode === 400 || statusCode === 401 || statusCode === 403) {
    return {
      status: 'permanent_failure',
      category: 'unauthorized',
      invalidatesSubscription: false,
    };
  }

  if (statusCode === 413) {
    return {
      status: 'permanent_failure',
      category: 'payload_too_large',
      invalidatesSubscription: false,
    };
  }

  if (statusCode === 429) {
    return {
      status: 'temporary_failure',
      category: 'rate_limited',
      invalidatesSubscription: false,
    };
  }

  if (statusCode >= 500) {
    return {
      status: 'temporary_failure',
      category: 'server_error',
      invalidatesSubscription: false,
    };
  }

  return {
    status: 'temporary_failure',
    category: 'unknown',
    invalidatesSubscription: false,
  };
}

/**
 * Classifies a thrown error, for failures that never produced a status code.
 *
 * Only the error's *shape* is inspected — never its message text, which can
 * embed the endpoint URL.
 */
export function classifyPushError(error: unknown): PushFailureClassification {
  const statusCode =
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof (error as { statusCode: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : null;

  if (statusCode !== null) {
    return classifyPushStatusCode(statusCode);
  }

  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : '';

  if (name === 'AbortError' || name === 'TimeoutError') {
    return { status: 'temporary_failure', category: 'timeout', invalidatesSubscription: false };
  }

  return { status: 'temporary_failure', category: 'network', invalidatesSubscription: false };
}

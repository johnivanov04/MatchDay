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
  | 'unknown'
  // APNs distinguishes "this token is wrong" from "this token is finished",
  // and separately from "your provider credentials are wrong". Web Push
  // collapses all three into a status code.
  | 'bad_device_token'
  | 'provider_config';

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


/**
 * Classifies an APNs rejection.
 *
 * ── THE REASON DECIDES, NOT THE STATUS ─────────────────────────────────────
 *
 * APNs returns a small set of statuses and a long list of `reason` strings, and
 * the status alone is not enough to act on. `403` covers five distinct
 * conditions: an expired provider token, an invalid one, a missing one, and two
 * certificate problems. Not one of them says anything about the device — they
 * all say MatchDay's own credentials are wrong. Retiring a player's phone
 * because a signing key expired would silently unsubscribe an entire user base
 * from one operator mistake, and they would have to notice and re-enable
 * notifications by hand.
 *
 * So the three device-fatal reasons are named explicitly, and everything else
 * is either the operator's problem or worth retrying.
 *
 * An unrecognised reason is temporary, for the same reason an unrecognised Web
 * Push status is: retrying something hopeless wastes a little work, while
 * permanently discarding something recoverable loses a match alert.
 */
export function classifyApnsFailure(
  status: number,
  reason: string | null,
): PushFailureClassification {
  switch (reason) {
    // ── The device is finished ─────────────────────────────────────────────
    //
    // Only reasons that prove *this token* can never be used again. Retiring a
    // registration is a decision the player cannot see and cannot undo without
    // finding the setting and turning notifications on again, so the bar is
    // that the token itself is dead — not that a send failed.
    //
    // `Unregistered` and `ExpiredToken` (410) are Apple saying the app is gone
    // from that device.
    //
    // `BadDeviceToken` is only meaningful because the environment is stored per
    // row: the usual cause of it — a production token offered to the sandbox
    // host, or the reverse — cannot happen here, because the row records which
    // environment its token was minted in and the sender picks the host from
    // that. What is left really is a token APNs will not accept.
    case 'Unregistered':
    case 'ExpiredToken':
      return { status: 'invalidated', category: 'gone', invalidatesSubscription: true };
    case 'BadDeviceToken':
      return {
        status: 'invalidated',
        category: 'bad_device_token',
        invalidatesSubscription: true,
      };

    // ── Our credentials are wrong ──────────────────────────────────────────
    //
    // Permanent, because retrying with the same key cannot help — but the
    // device is untouched. `record_push_delivery_result` has no branch for
    // `permanent_failure`, so the subscription is left exactly as it was and
    // starts working again the moment the key is fixed.
    case 'ExpiredProviderToken':
    case 'InvalidProviderToken':
    case 'MissingProviderToken':
    case 'BadCertificate':
    case 'BadCertificateEnvironment':
      return {
        status: 'permanent_failure',
        category: 'unauthorized',
        invalidatesSubscription: false,
      };

    // ── We built the request wrong ─────────────────────────────────────────
    //
    // Also permanent and also nothing to do with the device: a wrong topic, a
    // malformed header, a bad path. An operator or a deploy fixes these.
    // `DeviceTokenNotForTopic` reads like a device problem and is not one. It
    // says this token does not belong to the topic the request claimed, and the
    // topic comes from `APNS_BUNDLE_ID` — so the same rejection is produced by
    // a misconfigured bundle identifier, by a key issued for a different app,
    // and by an environment mismatch upstream of us. None of those are evidence
    // that the installation is dead, and treating them as such would retire
    // every iPhone in the database over one wrong environment variable.
    //
    // Permanent for this attempt, and the registration stays enabled: the
    // moment the configuration is corrected, delivery resumes with nobody
    // having to re-enable anything.
    case 'DeviceTokenNotForTopic':
    case 'BadTopic':
    case 'TopicDisallowed':
    case 'MissingTopic':
    case 'MissingDeviceToken':
    case 'BadPath':
    case 'MethodNotAllowed':
    case 'BadPriority':
    case 'BadExpirationDate':
    case 'BadMessageId':
    case 'BadCollapseId':
    case 'DuplicateHeaders':
    case 'InvalidPushType':
    case 'PayloadEmpty':
      return {
        status: 'permanent_failure',
        category: 'provider_config',
        invalidatesSubscription: false,
      };

    case 'PayloadTooLarge':
      return {
        status: 'permanent_failure',
        category: 'payload_too_large',
        invalidatesSubscription: false,
      };

    // ── Worth trying again ─────────────────────────────────────────────────
    //
    // `TooManyProviderTokenUpdates` is the one to be careful about: it means we
    // regenerated the signing JWT too often, and the fix is to reuse a cached
    // one — which `apns.ts` does — not to stop sending.
    case 'TooManyRequests':
    case 'TooManyProviderTokenUpdates':
      return { status: 'temporary_failure', category: 'rate_limited', invalidatesSubscription: false };
    case 'IdleTimeout':
      return { status: 'temporary_failure', category: 'timeout', invalidatesSubscription: false };
    case 'InternalServerError':
    case 'ServiceUnavailable':
    case 'Shutdown':
      return {
        status: 'temporary_failure',
        category: 'server_error',
        invalidatesSubscription: false,
      };

    default:
      break;
  }

  // No reason, or one Apple has added since this was written. Fall back to the
  // status, which at least distinguishes "their fault" from "unknown" — and
  // never invalidates a device on a status alone.
  if (status >= 500) {
    return { status: 'temporary_failure', category: 'server_error', invalidatesSubscription: false };
  }
  if (status === 429) {
    return { status: 'temporary_failure', category: 'rate_limited', invalidatesSubscription: false };
  }

  return { status: 'temporary_failure', category: 'unknown', invalidatesSubscription: false };
}

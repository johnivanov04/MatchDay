import 'server-only';

import type { PushPayload } from '@/lib/push/payload';

/**
 * The seam between "decide what to send" and "actually talk to a push service".
 *
 * Everything above this interface — eligibility, payload construction, failure
 * classification, delivery bookkeeping — is pure logic that tests exercise
 * directly with a fake. Nothing in the unit or database suites performs a real
 * network call, which is what keeps those suites deterministic and offline.
 */

export interface PushTarget {
  subscriptionId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushSendOutcome =
  | { ok: true }
  | { ok: false; statusCode: number }
  | { ok: false; error: unknown };

export interface PushSender {
  send(target: PushTarget, payload: PushPayload): Promise<PushSendOutcome>;
}

export interface VapidConfiguration {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/**
 * Reads VAPID configuration, or returns `null` when it is absent.
 *
 * Returning `null` rather than throwing is deliberate: push is a delivery
 * channel, and a deployment without keys configured must still run the whole
 * product. The canonical notification is already saved by the time anything
 * here is consulted, so "push not configured" degrades to "in-app only".
 *
 * `VAPID_PRIVATE_KEY` has no `NEXT_PUBLIC_` prefix and is read only inside this
 * server-only module, so it cannot reach a client bundle.
 */
export function readVapidConfiguration(): VapidConfiguration | null {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;

  if (
    publicKey === undefined ||
    publicKey.trim() === '' ||
    privateKey === undefined ||
    privateKey.trim() === '' ||
    subject === undefined ||
    subject.trim() === ''
  ) {
    return null;
  }

  return { subject, publicKey, privateKey };
}

/**
 * The real sender, backed by `web-push`.
 *
 * `web-push` is imported lazily so that merely importing this module — which
 * the dispatcher does on every request path that creates a notification — does
 * not pull the library and its crypto dependencies into memory on deployments
 * that have no VAPID keys configured.
 */
export function createWebPushSender(config: VapidConfiguration): PushSender {
  return {
    async send(target, payload) {
      try {
        const webpush = (await import('web-push')).default;
        webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);

        await webpush.sendNotification(
          {
            endpoint: target.endpoint,
            keys: { p256dh: target.p256dh, auth: target.auth },
          },
          JSON.stringify(payload),
          { TTL: 60 * 60 * 12 },
        );

        return { ok: true };
      } catch (error: unknown) {
        // The error is handed on unmodified for `classifyPushError` to inspect
        // structurally. It is never logged or stored here: `web-push` errors
        // embed the endpoint, which is a bearer credential.
        return { ok: false, error };
      }
    },
  };
}

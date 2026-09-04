import 'server-only';

import { randomUUID } from 'node:crypto';
import { dispatchEmailNotifications, type EmailDispatchStore } from '@/lib/email/dispatch';
import { createEmailDispatchStore } from '@/lib/email/email-store';
import {
  createResendSender,
  readEmailConfiguration,
  type EmailSender,
} from '@/lib/email/resend';
import {
  createDeliveryQueueStore,
  type DeliveryQueueStore,
} from '@/lib/notifications/delivery-queue';
import { logError, logInfo, logWarn } from '@/lib/observability/log';
import { createApnsSender, readApnsConfiguration } from '@/lib/push/apns';
import { dispatchPushNotifications, type PushDispatchStore } from '@/lib/push/dispatch';
import { createPushDispatchStore } from '@/lib/push/push-store';
import {
  createRoutingPushSender,
  createWebPushSender,
  readVapidConfiguration,
  type PushSender,
} from '@/lib/push/sender';

/**
 * One pass of the notification delivery worker.
 *
 * The queue exists so that publishing a match stops meaning "wait here while we
 * talk to Apple about every phone in the league". A trigger writes one job per
 * push-eligible notification inside the notification's own transaction; this
 * drains them.
 *
 * ── THE SHAPE OF A PASS ────────────────────────────────────────────────────
 *
 * Claim a bounded batch, commit the claim, *then* do the network work, then
 * record the outcome. The three are separate round trips on purpose: holding a
 * database transaction open across a call to APNs would put a lock on the queue
 * for as long as a third party feels like taking, which is the failure this
 * whole phase exists to remove from the request path — not one to relocate into
 * the database.
 *
 * ── DELIVERY GUARANTEE: AT LEAST ONCE ──────────────────────────────────────
 *
 * The job commits with the notification, so it cannot be lost. A worker that
 * dies after sending but before recording leaves a lease that expires, and the
 * job is claimed again — so a send can genuinely happen twice.
 *
 * What stops that reaching somebody's phone twice is one layer down and is not
 * part of this guarantee: `push_delivery_attempts` is unique per (notification,
 * subscription), and the dispatcher skips any pair already in a terminal state.
 * That makes a duplicate *alert* unlikely. It does not make it impossible,
 * because the provider call happens before the row is written and nothing can
 * make those two atomic across a network boundary. This is at-least-once with
 * strong de-duplication, and it is deliberately not described as exactly-once.
 */

export type DeliveryRunStatus =
  /** The queue was read and had nothing in it. The healthy common case. */
  | 'idle'
  /** At least one job was claimed and taken to a terminal state. */
  | 'worked'
  /** No service-role key, or no push transport configured. Nothing ran. */
  | 'skipped'
  /** The queue itself could not be read or written. Nothing was drained. */
  | 'failed';

export interface DeliveryRunResult {
  status: DeliveryRunStatus;
  /** Jobs claimed by this pass. */
  claimed: number;
  /** Jobs that reached `completed`. */
  completed: number;
  /** Jobs that reached `failed`. */
  failed: number;
  /** Jobs handed back for a later provider round. */
  rescheduled: number;
  /** Jobs that reached `failed` specifically because the retry budget ran out. */
  exhausted: number;
  /** Individual provider sends that succeeded, across every job and channel. */
  sent: number;
  /**
   * Messages the email provider accepted, a subset of `sent`.
   *
   * NOT named after the channel. The observability filter drops any key
   * containing "email" — see `FORBIDDEN_KEY_PARTS` — so the obvious name would
   * have been stripped from every log line without a word, which is exactly
   * what happened to `reminder.skipped`'s `reason` field in Phase 5.
   */
  mailSent: number;
  /**
   * Stable error code when `status` is `failed`, for correlating log lines.
   * Never the database's message, which can name constraints and other tenants.
   */
  errorCode: string | null;
}

export interface DeliveryRunOptions {
  /** Jobs per claim. Clamped again in SQL, which is the real bound. */
  batchSize?: number;
  /** Ceiling on jobs in one pass, so a backlog cannot run past the wall clock. */
  maxJobs?: number;
  /** Wall-clock budget. Checked between batches, never mid-batch. */
  timeBudgetMs?: number;
  /** How long a claim is believed. Must outlast the slowest realistic batch. */
  leaseSeconds?: number;
  /** Injected in tests; production builds them from the environment. */
  deps?: {
    queue: DeliveryQueueStore | null;
    store: PushDispatchStore | null;
    sender: PushSender | null;
    /** Phase 3D. Absent means the email channel is not configured. */
    emailStore?: EmailDispatchStore | null;
    emailSender?: EmailSender | null;
    baseUrl?: string;
    emailFrom?: string;
  };
}

const DEFAULTS = {
  batchSize: 25,
  maxJobs: 200,
  timeBudgetMs: 45_000,
  leaseSeconds: 120,
} as const;

/** Kept so callers and tests can ask the question without restating it. */
export function deliveryRunFailed(result: DeliveryRunResult): boolean {
  return result.status === 'failed';
}

export async function runNotificationDelivery(
  options: DeliveryRunOptions = {},
): Promise<DeliveryRunResult> {
  const batchSize = options.batchSize ?? DEFAULTS.batchSize;
  const maxJobs = options.maxJobs ?? DEFAULTS.maxJobs;
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULTS.timeBudgetMs;
  const leaseSeconds = options.leaseSeconds ?? DEFAULTS.leaseSeconds;

  const { queue, store, sender, emailStore, emailSender, baseUrl, emailFrom } =
    options.deps ?? buildDependencies();

  // NOTHING IS CLAIMED WHEN THERE IS NOWHERE TO SEND.
  //
  // A deployment with no service-role key, or with neither VAPID nor APNs
  // credentials, leaves its jobs `pending` rather than claiming them and
  // marking them done. Completing a job nothing could deliver would quietly
  // discard the notification the moment an operator finally set the variable —
  // and the whole point of a durable queue is that work waits.
  if (queue === null || store === null || sender === null) {
    logWarn('notification_delivery.skipped', {
      service_role_configured: queue !== null && store !== null,
      transport_configured: sender !== null,
    });
    return {
      status: 'skipped',
      claimed: 0,
      completed: 0,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
      sent: 0,
      mailSent: 0,
      errorCode: null,
    };
  }

  // Opaque and per-pass. Never a hostname or a deployment URL: this lands in a
  // column operators read, and `claimed_by` is not a place to start leaking
  // infrastructure detail.
  const worker = `w-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();

  let claimed = 0;
  let completed = 0;
  let failed = 0;
  let rescheduled = 0;
  let exhausted = 0;
  let sent = 0;
  let mailSent = 0;

  try {
    while (claimed < maxJobs && Date.now() - startedAt < timeBudgetMs) {
      const remaining = Math.min(batchSize, maxJobs - claimed);
      const jobs = await queue.claim(worker, remaining, leaseSeconds);

      if (jobs.length === 0) {
        break;
      }

      claimed += jobs.length;

      for (const job of jobs) {
        // One job is one notification, so a single bad notification cannot take
        // the batch down with it. `dispatchPushNotifications` is documented
        // never to throw; the catch is what keeps that from being silently lost
        // the day it stops holding.
        // ── PHASE 3D: TWO CHANNELS, ONE VERDICT ──────────────────────────
        //
        // Push and email are dispatched independently and their results added
        // together, so everything below — the retry decision, the terminal
        // states, the 3C backoff — works on a total rather than on a channel.
        //
        // That addition is what makes cross-channel partial fanout fall out
        // rather than be special-cased. APNs sent, Web Push sent, email rate
        // limited gives `retryable: 1`, the job is rescheduled, and the next
        // pass re-sends to nobody: each channel's own store already treats a
        // delivered pair as terminal and skips it.
        let outcome = { sent: 0, attempted: 0, retryable: 0, aborted: false };

        try {
          const push = await dispatchPushNotifications([job.job_notification_id], {
            store,
            sender,
          });

          // A deployment with no email configured contributes nothing at all —
          // not a skip that could be mistaken for work, and not a failure.
          const email =
            emailStore == null
              ? { sent: 0, attempted: 0, retryable: 0, aborted: false }
              : await dispatchEmailNotifications([job.job_notification_id], {
                  store: emailStore,
                  sender: emailSender ?? null,
                  baseUrl: baseUrl ?? '',
                  from: emailFrom ?? '',
                });

          mailSent += email.sent;

          outcome = {
            sent: push.sent + email.sent,
            attempted: push.attempted + email.attempted,
            retryable: push.retryable + email.retryable,
            aborted: push.aborted || email.aborted,
          };
        } catch {
          // Both dispatchers are documented never to throw and report an
          // incomplete pass through `aborted` instead. This catch is what stops
          // that guarantee being silently lost the day it changes. Deliberately
          // not logged with the error object: a failure here can carry
          // endpoints, addresses and provider responses.
          outcome = { sent: 0, attempted: 0, retryable: 0, aborted: true };
        }

        // WHAT COUNTS AS A FAILED JOB.
        //
        // Not "some device did not get it" — a league where one member's phone
        // has a dead endpoint is a normal, successful fanout, and the per-device
        // outcome is already recorded on `push_delivery_attempts`.
        //
        // A job failed when the pass could not be carried out, or when every
        // attempt it made was rejected. A job that attempted nothing — no
        // enabled devices, a type the dispatcher declined — is `completed`,
        // because there is genuinely nothing left owed.
        //
        // `aborted` is the third case, and the one that is easy to miss: the
        // dispatcher gave up part way and reports zero attempts, which looks
        // exactly like "nobody to send to" unless you ask. Completing such a
        // job would discard a notification nobody ever received.
        sent += outcome.sent;

        // PHASE 3C — the order of these branches is the policy.
        //
        // `retryable` outranks everything except an aborted pass, and that is
        // the partial-fanout rule: a notification that reached one phone and
        // was rate limited on another is NOT finished, even though something
        // was delivered. The successful attempt is already terminal in
        // `push_delivery_attempts`, so the next round re-sends to nobody who
        // already has it — `alreadyDelivered` skips `sent` pairs.
        //
        // Only once nothing retryable remains does the job settle: `failed` if
        // every attempt was permanently refused, `completed` otherwise —
        // including the case where there was nothing to attempt at all, which
        // is a finished job and not a failure.
        let moved: boolean;

        if (outcome.aborted) {
          moved = await queue.fail(job.job_id, 'dispatch_error');
          failed += 1;
        } else if (outcome.retryable > 0) {
          const decision = await queue.reschedule(job.job_id, 'temporary_failure');

          if (decision.outcome === 'exhausted') {
            failed += 1;
            exhausted += 1;
            logWarn('notification_delivery.retry_exhausted', {
              job_id: job.job_id,
              retry_number: decision.retry_number ?? 0,
              error_category: 'retries_exhausted',
            });
          } else if (decision.outcome === 'scheduled') {
            rescheduled += 1;
            logInfo('notification_delivery.retry_scheduled', {
              job_id: job.job_id,
              retry_number: decision.retry_number ?? 0,
              error_category: 'temporary_failure',
              next_attempt_at: decision.scheduled_for ?? '',
            });
          }

          moved = decision.outcome !== 'not_claimed';
        } else if (outcome.attempted > 0 && outcome.sent === 0) {
          moved = await queue.fail(job.job_id, 'all_attempts_failed');
          failed += 1;
        } else {
          moved = await queue.complete(job.job_id);
          completed += 1;
        }

        // The job moved on under somebody else's claim — this worker's lease
        // had expired and a second one took over. Harmless, and worth seeing,
        // because a run that logs this repeatedly has a lease shorter than its
        // own batches.
        if (!moved) {
          logWarn('notification_delivery.stale_claim', { job_id: job.job_id });
        }
      }
    }
  } catch (error: unknown) {
    // The queue itself is unreachable or refusing. Claimed jobs keep their
    // leases and are picked up by the next pass once those expire, so nothing
    // is lost — but this is emphatically not a quiet run and must not report
    // itself as one.
    const errorCode =
      typeof (error as { code?: unknown })?.code === 'string'
        ? (error as { code: string }).code
        : 'unknown';
    logError('notification_delivery.failed', { error_code: errorCode, claimed, completed, failed });
    return {
      status: 'failed',
      claimed,
      completed,
      failed,
      rescheduled,
      exhausted,
      sent,
      mailSent,
      errorCode,
    };
  }

  // Counts and ids only. No recipient, no league, no title, and above all no
  // device token — a log line is read by more people and kept longer than any
  // screen in the product.
  logInfo('notification_delivery.run', {
    claimed,
    completed,
    failed,
    rescheduled,
    exhausted,
    sent,
    mail_sent: mailSent,
    duration_ms: Date.now() - startedAt,
  });

  if (failed > 0) {
    logWarn('notification_delivery.incomplete', { claimed, failed });
  }

  return {
    status: claimed === 0 ? 'idle' : 'worked',
    claimed,
    completed,
    failed,
    rescheduled,
    exhausted,
    sent,
    mailSent,
    errorCode: null,
  };
}

/**
 * Production wiring. Either transport, both, or neither — a channel with no
 * credentials makes its devices skip rather than fail, so a deployment can gain
 * APNs later without a backlog of permanently-failed rows to unpick.
 */
function buildDependencies(): {
  queue: DeliveryQueueStore | null;
  store: PushDispatchStore | null;
  sender: PushSender | null;
  emailStore: EmailDispatchStore | null;
  emailSender: EmailSender | null;
  baseUrl: string;
  emailFrom: string;
} {
  const vapid = readVapidConfiguration();
  const apns = readApnsConfiguration();

  // Read here rather than at module load, so a deployment with no
  // `RESEND_API_KEY` starts and delivers push exactly as before. Email is the
  // only thing missing, and it is missing quietly.
  const email = readEmailConfiguration();

  return {
    queue: createDeliveryQueueStore(),
    store: createPushDispatchStore(),
    sender:
      vapid === null && apns === null
        ? null
        : createRoutingPushSender({
            web_push: vapid === null ? null : createWebPushSender(vapid),
            apns: apns === null ? null : createApnsSender(apns),
          }),
    emailStore: email === null ? null : createEmailDispatchStore(),
    emailSender: email === null ? null : createResendSender(email),
    // Links in an email must be absolute and must point at the real product.
    baseUrl: process.env.NEXT_PUBLIC_SITE_URL ?? '',
    // Part of the request, and therefore part of its fingerprint.
    emailFrom: email?.from ?? '',
  };
}

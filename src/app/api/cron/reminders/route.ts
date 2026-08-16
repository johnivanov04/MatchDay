import { NextResponse, type NextRequest } from 'next/server';
import { signalHeartbeat } from '@/lib/observability/heartbeat';
import { runDueReminders } from '@/server/reminders';

/**
 * The endpoint a production scheduler calls to deliver due reminders.
 *
 * This is the *only* scheduling mechanism in the repository. There is no timer,
 * no interval and no background loop, because a `setTimeout` dies with the
 * process and a process-local timer fires once per running instance — neither
 * is a scheduler on a platform that scales to zero and redeploys freely.
 *
 * `vercel.json` declares the cron entry that invokes this. See
 * `docs/operations/production.md` §5 for the deploy-time steps that remain
 * external, and for the `pg_cron` alternative.
 *
 * Authorization is a shared secret, not a session: the caller is a machine. It
 * is compared in constant time and the endpoint answers 404 without one, so it
 * cannot be probed for existence.
 */
export const dynamic = 'force-dynamic';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

async function handle(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;

  // With no secret configured the endpoint does not exist. That is the safe
  // default: an unprotected reminder trigger lets anybody flush a league's
  // reminders early.
  if (secret === undefined || secret.trim() === '') {
    return new NextResponse(null, { status: 404 });
  }

  const authorization = request.headers.get('authorization') ?? '';
  const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';

  if (!timingSafeEqual(presented, secret)) {
    return new NextResponse(null, { status: 404 });
  }

  const result = await runDueReminders();

  // A FAILED RUN MUST NOT LOOK LIKE A SUCCESSFUL ONE.
  //
  // 500 so the platform's own cron dashboard and any uptime check count it as a
  // failure, rather than the operator having to notice that a 200 body said
  // `"status":"failed"`. `skipped` is 503: nothing ran and nothing will until
  // somebody sets the service-role key, which is a configuration problem rather
  // than a transient one.
  const httpStatus = result.status === 'failed' ? 500 : result.status === 'skipped' ? 503 : 200;

  // ── External heartbeat ──────────────────────────────────────────────────
  //
  // `reminder.run` is emitted on every pass so that its *absence* is the
  // signal, but a deployment that has stopped running crons cannot notice its
  // own silence. This tells an outside observer that the scheduler executed.
  //
  // WHAT COUNTS AS SUCCESS. Scheduler execution, not whether reminders happened
  // to be due — an `idle` pass with `claimed: 0` is a perfectly healthy
  // heartbeat and must not alarm anybody at two in the morning.
  //
  // `skipped` is grouped with `failed`, which is a judgement the requirements
  // did not spell out: it means no service-role key is configured, so nothing
  // ran and nothing will until an operator acts. Reminders are not being
  // delivered, and reporting that as healthy would be the monitoring lying. It
  // is also consistent with the 503 already returned above.
  //
  // AWAITED, AND DELIBERATELY SO. On a serverless platform the function can be
  // frozen the instant the response is returned, so an un-awaited ping is not
  // reliably sent. `signalHeartbeat` never throws and is bounded by its own
  // short timeout, so this can neither fail the run nor stall it meaningfully.
  const heartbeatKind = result.status === 'failed' || result.status === 'skipped'
    ? 'failure'
    : 'success';

  try {
    await signalHeartbeat(heartbeatKind);
  } catch {
    // `signalHeartbeat` is documented never to throw, and its own tests hold it
    // to that. This catch is defence in depth rather than distrust: the one
    // outcome that must be impossible is a monitoring bug turning a completed
    // reminder run into a failed cron response, and a future refactor of the
    // helper should not be able to reintroduce it. Deliberately silent — the
    // helper owns its own logging, and an error object here could carry the
    // heartbeat URL.
  }

  // Unchanged: the heartbeat's outcome is deliberately not consulted. A
  // monitoring provider being down must not turn a successful reminder run into
  // a cron failure, nor mask the original error when the run genuinely failed.
  return NextResponse.json(result, { status: httpStatus });
}

/**
 * Vercel Cron issues **GET**, and injects `Authorization: Bearer $CRON_SECRET`
 * automatically when that variable is set on the project. Supporting GET is
 * therefore what makes the declared cron entry work at all — it is the same
 * contract and the same secret check as POST, not a second mechanism.
 *
 * A mutating GET is a deliberate, bounded exception to the usual rule. The
 * operation is effectively idempotent: `generate_due_reminders()` claims
 * pending rows with `for update skip locked`, and every notification it writes
 * carries a recipient-scoped idempotency key, so a repeated or concurrent
 * invocation cannot produce a second copy of anything. Nothing here is
 * cacheable — `dynamic = 'force-dynamic'` — and without the bearer secret it is
 * a 404.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

/** The verb `npm run reminders:run` and the documented `curl` use. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

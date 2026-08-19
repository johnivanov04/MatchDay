import { NextResponse, type NextRequest } from 'next/server';
import { runAccountDeletionReconciliation } from '@/server/account-deletion';

/**
 * The endpoint a production scheduler calls to finish abandoned account
 * deletions.
 *
 * ── WHY THERE IS A JOB AT ALL ──────────────────────────────────────────────
 *
 * Deleting an account spans Postgres, Storage and GoTrue, and only the first is
 * transactional. A deletion can therefore stop half-finished — most seriously
 * with the profile scrubbed and the Auth row surviving, which still holds the
 * person's real email address. Whether that ever finishes must not depend on
 * somebody who has just left the product coming back to press a button.
 *
 * The user-facing retry on `/account/deleted` does the same work immediately.
 * This is the safety net behind it, not the primary path.
 *
 * ── AUTHORIZATION ──────────────────────────────────────────────────────────
 *
 * Deliberately identical to `/api/cron/reminders`: a shared secret rather than
 * a session, because the caller is a machine; compared in constant time; and a
 * 404 without it, so the endpoint cannot be probed for existence. It reuses
 * `CRON_SECRET` rather than introducing a second secret to rotate.
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

  // With no secret configured the endpoint does not exist. An unprotected
  // deletion reconciler is a way to make somebody enumerate how many accounts
  // are mid-deletion, and to spend service-role calls at will.
  if (secret === undefined || secret.trim() === '') {
    return new NextResponse(null, { status: 404 });
  }

  const authorization = request.headers.get('authorization') ?? '';
  const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';

  if (!timingSafeEqual(presented, secret)) {
    return new NextResponse(null, { status: 404 });
  }

  const result = await runAccountDeletionReconciliation();

  // A FAILED RUN MUST NOT LOOK LIKE A SUCCESSFUL ONE — the same rule the
  // reminder endpoint follows, for the same reason: the platform's cron
  // dashboard counts HTTP status, not a `"status"` field somebody has to read.
  //
  // `outstanding > 0` is deliberately NOT an error. An account waiting on a
  // briefly unreachable GoTrue is the system working as designed; alerting on
  // it would train an operator to ignore the alert. What matters is the number
  // staying above zero across many passes, which is a question for a dashboard
  // rather than for one response code.
  const httpStatus = result.status === 'failed' ? 500 : result.status === 'skipped' ? 503 : 200;

  return NextResponse.json(result, { status: httpStatus });
}

/**
 * Vercel Cron issues **GET** and injects `Authorization: Bearer $CRON_SECRET`.
 * Supporting it is what makes the declared entry in `vercel.json` work.
 *
 * The mutating GET is the same bounded exception the reminder endpoint makes,
 * and rests on the same property: every step of this job is idempotent, so a
 * repeated or concurrent invocation cannot produce a different outcome from a
 * single one. Nothing here is cacheable, and without the bearer secret it is a
 * 404.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

/** For a manual `curl` and for the local controlled exercise of this job. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

import { NextResponse, type NextRequest } from 'next/server';
import { runNotificationDelivery } from '@/server/notification-delivery';

/**
 * The endpoint a production scheduler calls to drain queued push deliveries.
 *
 * Third of three cron endpoints, and deliberately identical to the other two in
 * every operational respect: same shared secret, same constant-time comparison,
 * same 404 for a caller without it, same rule that a failed run answers 5xx.
 * There is no second operational model here — an operator who knows how the
 * reminder cron behaves already knows how this one behaves.
 *
 * `vercel.json` declares the entry that invokes it. See
 * `docs/operations/production.md` for the deploy-time steps.
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
  // drain lets anybody flush the queue — and, because delivery is the one
  // operation here that reaches out to third parties, lets anybody make this
  // deployment generate traffic towards Apple on demand.
  if (secret === undefined || secret.trim() === '') {
    return new NextResponse(null, { status: 404 });
  }

  const authorization = request.headers.get('authorization') ?? '';
  const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';

  if (!timingSafeEqual(presented, secret)) {
    return new NextResponse(null, { status: 404 });
  }

  const result = await runNotificationDelivery();

  // A FAILED RUN MUST NOT LOOK LIKE A SUCCESSFUL ONE — the same rule, and the
  // same status mapping, as the other two endpoints.
  //
  // `failed > 0` is deliberately NOT a 500. Individual notifications whose
  // every device rejected them are recorded and counted, and a league with one
  // stale endpoint would otherwise turn a healthy drain into a red cron every
  // ten minutes until somebody stopped reading the alerts.
  const httpStatus = result.status === 'failed' ? 500 : result.status === 'skipped' ? 503 : 200;

  return NextResponse.json(result, { status: httpStatus });
}

/**
 * Vercel Cron issues **GET** and injects `Authorization: Bearer $CRON_SECRET`.
 * Supporting it is what makes the declared entry in `vercel.json` work.
 *
 * The mutating GET is the same bounded exception the other two endpoints make,
 * and rests on the same property. Claiming is `for update skip locked` and
 * every delivery is unique per (notification, subscription), so a repeated or
 * concurrent invocation drains faster but cannot deliver anything twice that a
 * single invocation would not. Nothing here is cacheable, and without the
 * bearer secret it is a 404.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

/** For a manual `curl` and for the local controlled exercise of this job. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

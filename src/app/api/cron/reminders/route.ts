import { NextResponse, type NextRequest } from 'next/server';
import { runDueReminders } from '@/server/reminders';

/**
 * The endpoint a production scheduler calls to deliver due reminders.
 *
 * This is the *only* scheduling mechanism in the repository. There is no timer,
 * no interval and no background loop, because a `setTimeout` dies with the
 * process and a process-local timer fires once per running instance — neither
 * is a scheduler on a platform that scales to zero and redeploys freely.
 *
 * Production must invoke this on a cadence. See `NEXT_STEPS.md`; a Vercel Cron
 * entry or a Supabase `pg_cron` job calling `generate_due_reminders()` are both
 * fine. Nothing here configures one, so until an operator does, reminders do
 * not go out — stated plainly rather than assumed.
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

export async function POST(request: NextRequest): Promise<NextResponse> {
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

  return NextResponse.json(result);
}

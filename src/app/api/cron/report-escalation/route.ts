import { NextResponse, type NextRequest } from 'next/server';
import { runReportEscalation } from '@/server/report-escalation';

/**
 * The endpoint that puts new content reports in front of a human.
 *
 * Fourth cron endpoint, and deliberately identical to the other three in every
 * operational respect: same shared secret, same constant-time comparison, same
 * 404 for a caller without it, same rule that a failed run answers 5xx. An
 * operator who knows how the reminder cron behaves already knows how this one
 * behaves.
 *
 * Unlike the delivery cron, a failed run here IS a 500 without qualification.
 * There is no per-item outcome to be tolerant of: either the digest reached the
 * people who handle reports or it did not, and the second case must be loud.
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

  if (secret === undefined || secret.trim() === '') {
    return new NextResponse(null, { status: 404 });
  }

  const authorization = request.headers.get('authorization') ?? '';
  const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';

  if (!timingSafeEqual(presented, secret)) {
    return new NextResponse(null, { status: 404 });
  }

  const result = await runReportEscalation();

  const httpStatus = result.status === 'failed' ? 500 : result.status === 'skipped' ? 503 : 200;

  return NextResponse.json(result, { status: httpStatus });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ReminderRunResult } from '@/server/reminders';

/**
 * The contract the production scheduler depends on.
 *
 * Exercised at the route-handler level rather than through the browser because
 * the E2E server deliberately runs without a `CRON_SECRET` — which is what lets
 * that suite prove the endpoint does not exist without one. The authorized path
 * needs a configured secret, so it is proved here.
 */

const mocks = vi.hoisted(() => ({ runDueReminders: vi.fn() }));

vi.mock('@/server/reminders', () => ({ runDueReminders: mocks.runDueReminders }));

const route = await import('@/app/api/cron/reminders/route');

const SECRET = 'test-cron-secret-value';
const ORIGINAL = process.env.CRON_SECRET;

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/cron/reminders', { method: 'GET', headers });
}

const authorized = () => request({ authorization: `Bearer ${SECRET}` });

function result(overrides: Partial<ReminderRunResult> = {}): ReminderRunResult {
  return {
    status: 'idle',
    claimed: 0,
    notified: 0,
    pushFailures: 0,
    errorCode: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  mocks.runDueReminders.mockResolvedValue(result());
});

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = ORIGINAL;
  }
});

describe('authorization', () => {
  it('answers 404 with no secret configured, so the route cannot be probed', async () => {
    delete process.env.CRON_SECRET;

    expect((await route.GET(request())).status).toBe(404);
    expect(mocks.runDueReminders).not.toHaveBeenCalled();
  });

  it('answers 404 with no Authorization header', async () => {
    expect((await route.GET(request())).status).toBe(404);
    expect(mocks.runDueReminders).not.toHaveBeenCalled();
  });

  it('answers 404 for a wrong secret', async () => {
    const response = await route.GET(request({ authorization: 'Bearer wrong-value-entirely' }));

    // 404, not 401: a 401 would confirm the endpoint exists and is worth
    // attacking. Indistinguishable from a route that was never deployed.
    expect(response.status).toBe(404);
    expect(mocks.runDueReminders).not.toHaveBeenCalled();
  });

  it('answers 404 for a correct secret sent without the Bearer scheme', async () => {
    expect((await route.GET(request({ authorization: SECRET }))).status).toBe(404);
  });

  it('answers 404 for a secret that is a prefix of the real one', async () => {
    expect(
      (await route.GET(request({ authorization: `Bearer ${SECRET.slice(0, -1)}` }))).status,
    ).toBe(404);
  });

  it('runs the pass for a correct secret', async () => {
    const response = await route.GET(authorized());

    expect(response.status).toBe(200);
    expect(mocks.runDueReminders).toHaveBeenCalledTimes(1);
  });
});

describe('both verbs, one contract', () => {
  it('accepts GET, which is what Vercel Cron issues', async () => {
    // Vercel Cron sends GET and injects `Authorization: Bearer $CRON_SECRET`.
    // Without a GET handler the declared cron entry in `vercel.json` would do
    // nothing at all.
    expect((await route.GET(authorized())).status).toBe(200);
  });

  it('accepts POST, which the documented curl and the local script use', async () => {
    expect((await route.POST(authorized())).status).toBe(200);
  });

  it('applies the same authorization to both', async () => {
    expect((await route.GET(request())).status).toBe(404);
    expect((await route.POST(request())).status).toBe(404);
  });
});

describe('the HTTP status reflects the outcome', () => {
  it('returns 200 for a healthy run with nothing due', async () => {
    mocks.runDueReminders.mockResolvedValue(result({ status: 'idle' }));

    const response = await route.GET(authorized());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'idle' });
  });

  it('returns 200 when work was done', async () => {
    mocks.runDueReminders.mockResolvedValue(
      result({ status: 'worked', claimed: 2, notified: 7 }),
    );

    const response = await route.GET(authorized());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'worked', claimed: 2, notified: 7 });
  });

  it('returns 500 when the run failed', async () => {
    mocks.runDueReminders.mockResolvedValue(result({ status: 'failed', errorCode: '42501' }));

    const response = await route.GET(authorized());

    // THE POINT: a failed run must not answer 200. The platform's cron
    // dashboard and any uptime check read the status code, not the body, so a
    // 200 saying `"status":"failed"` is a failure nobody is told about.
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ status: 'failed' });
  });

  it('returns 503 when nothing ran for want of configuration', async () => {
    mocks.runDueReminders.mockResolvedValue(result({ status: 'skipped' }));

    const response = await route.GET(authorized());

    // Distinct from 500: retrying will not help until an operator sets the
    // service-role key.
    expect(response.status).toBe(503);
  });

  it('gives a failed run and an idle run different status codes', async () => {
    mocks.runDueReminders.mockResolvedValue(result({ status: 'failed' }));
    const failed = await route.GET(authorized());

    mocks.runDueReminders.mockResolvedValue(result({ status: 'idle' }));
    const idle = await route.GET(authorized());

    expect(failed.status).not.toBe(idle.status);
  });
});

describe('the response body leaks nothing', () => {
  it('carries counts and a stable code, never a database message', async () => {
    mocks.runDueReminders.mockResolvedValue(result({ status: 'failed', errorCode: '23505' }));

    const body = (await (await route.GET(authorized())).json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      'claimed',
      'errorCode',
      'notified',
      'pushFailures',
      'status',
    ]);
    expect(body['errorCode']).toBe('23505');
  });

  it('never echoes the secret', async () => {
    const body = await (await route.GET(authorized())).text();

    expect(body).not.toContain(SECRET);
  });
});

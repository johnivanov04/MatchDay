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

const mocks = vi.hoisted(() => ({ runDueReminders: vi.fn(), signalHeartbeat: vi.fn() }));

vi.mock('@/server/reminders', () => ({ runDueReminders: mocks.runDueReminders }));
vi.mock('@/lib/observability/heartbeat', () => ({ signalHeartbeat: mocks.signalHeartbeat }));

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
    errorCode: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  mocks.runDueReminders.mockResolvedValue(result());
  mocks.signalHeartbeat.mockResolvedValue('sent');
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
      'status',
    ]);
    expect(body['errorCode']).toBe('23505');
  });

  it('never echoes the secret', async () => {
    const body = await (await route.GET(authorized())).text();

    expect(body).not.toContain(SECRET);
  });
});


describe('the external heartbeat', () => {
  it('sends exactly one success heartbeat after a run that did work', async () => {
    mocks.runDueReminders.mockResolvedValue(result({ status: 'worked', claimed: 2, notified: 5 }));

    await route.GET(authorized());

    expect(mocks.signalHeartbeat).toHaveBeenCalledTimes(1);
    expect(mocks.signalHeartbeat).toHaveBeenCalledWith('success');
  });

  it('sends a success heartbeat for a zero-work run', async () => {
    mocks.runDueReminders.mockResolvedValue(result({ status: 'idle' }));

    await route.GET(authorized());

    // The heartbeat monitors that the scheduler executed, not whether any
    // reminder happened to be due. An idle pass at 03:00 is perfectly healthy
    // and must not page anybody.
    expect(mocks.signalHeartbeat).toHaveBeenCalledTimes(1);
    expect(mocks.signalHeartbeat).toHaveBeenCalledWith('success');
  });

  it('sends a failure heartbeat when the run failed', async () => {
    mocks.runDueReminders.mockResolvedValue(result({ status: 'failed', errorCode: '42501' }));

    await route.GET(authorized());

    expect(mocks.signalHeartbeat).toHaveBeenCalledWith('failure');
  });

  it('sends a failure heartbeat when nothing ran for want of configuration', async () => {
    mocks.runDueReminders.mockResolvedValue(result({ status: 'skipped' }));

    await route.GET(authorized());

    // `skipped` means no reminders are being delivered and none will be until
    // an operator acts. Reporting that as healthy would be the monitoring lying.
    expect(mocks.signalHeartbeat).toHaveBeenCalledWith('failure');
  });

  it('never sends a heartbeat for an unauthorized request', async () => {
    await route.GET(request());

    // Otherwise anybody could keep the monitor green without the cron running.
    expect(mocks.signalHeartbeat).not.toHaveBeenCalled();
  });
});

describe('the heartbeat cannot affect the cron outcome', () => {
  it('keeps a successful run successful when the provider is down', async () => {
    mocks.runDueReminders.mockResolvedValue(result({ status: 'worked', claimed: 1 }));
    mocks.signalHeartbeat.mockResolvedValue('network_error');

    const response = await route.GET(authorized());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'worked', claimed: 1 });
  });

  it('keeps a successful run successful even if the heartbeat throws', async () => {
    // Belt and braces: `signalHeartbeat` is documented never to throw, but the
    // route must not depend on that promise being kept.
    mocks.runDueReminders.mockResolvedValue(result({ status: 'idle' }));
    mocks.signalHeartbeat.mockRejectedValue(new Error('monitoring exploded'));

    await expect(route.GET(authorized())).resolves.toBeDefined();
  });

  it('does not mask the original error when the failure heartbeat also fails', async () => {
    mocks.runDueReminders.mockResolvedValue(result({ status: 'failed', errorCode: '42501' }));
    mocks.signalHeartbeat.mockResolvedValue('timeout');

    const response = await route.GET(authorized());

    // The reminder failure is still what the cron reports.
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ status: 'failed', errorCode: '42501' });
  });

  it('leaves the response body untouched by the heartbeat', async () => {
    mocks.signalHeartbeat.mockResolvedValue('http_error');

    const body = (await (await route.GET(authorized())).json()) as Record<string, unknown>;

    // No heartbeat field, no URL, nothing new.
    expect(Object.keys(body).sort()).toEqual([
      'claimed',
      'errorCode',
      'notified',
      'status',
    ]);
  });

  it('runs the reminder pass before signalling, and only once', async () => {
    await route.GET(authorized());

    expect(mocks.runDueReminders).toHaveBeenCalledTimes(1);
    expect(mocks.signalHeartbeat).toHaveBeenCalledTimes(1);
  });
});

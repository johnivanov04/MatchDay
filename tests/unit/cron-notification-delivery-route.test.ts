import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { DeliveryRunResult } from '@/server/notification-delivery';

/**
 * The delivery endpoint's contract with the production scheduler.
 *
 * Exercised at the route-handler level for the same reason the reminder suite
 * gives: the E2E server deliberately runs without a `CRON_SECRET`, which is
 * what lets that suite prove the endpoint does not exist without one, so the
 * authorized path has to be proved here.
 *
 * This endpoint is the one that reaches out to Apple and to Web Push. An
 * unauthenticated caller who could reach it could make this deployment
 * generate outbound traffic on demand, so the authorization assertions below
 * matter more here than on either of its siblings.
 */

const mocks = vi.hoisted(() => ({ runNotificationDelivery: vi.fn() }));

vi.mock('@/server/notification-delivery', () => ({
  runNotificationDelivery: mocks.runNotificationDelivery,
}));

const route = await import('@/app/api/cron/notification-delivery/route');

const SECRET = 'test-cron-secret-value';
const ORIGINAL = process.env.CRON_SECRET;

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/cron/notification-delivery', {
    method: 'GET',
    headers,
  });
}

const authorized = () => request({ authorization: `Bearer ${SECRET}` });

function result(overrides: Partial<DeliveryRunResult> = {}): DeliveryRunResult {
  return {
    status: 'idle',
    claimed: 0,
    completed: 0,
    failed: 0,
    sent: 0,
    errorCode: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  mocks.runNotificationDelivery.mockResolvedValue(result());
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

    const response = await route.GET(authorized());

    expect(response.status).toBe(404);
    expect(mocks.runNotificationDelivery).not.toHaveBeenCalled();
  });

  it('answers 404 for a secret configured as whitespace', async () => {
    process.env.CRON_SECRET = '   ';

    expect((await route.GET(request({ authorization: 'Bearer    ' }))).status).toBe(404);
    expect(mocks.runNotificationDelivery).not.toHaveBeenCalled();
  });

  it('answers 404 with no Authorization header', async () => {
    expect((await route.GET(request())).status).toBe(404);
    expect(mocks.runNotificationDelivery).not.toHaveBeenCalled();
  });

  it('answers 404 for a wrong secret', async () => {
    const response = await route.GET(request({ authorization: 'Bearer not-the-secret' }));

    expect(response.status).toBe(404);
    expect(mocks.runNotificationDelivery).not.toHaveBeenCalled();
  });

  it('answers 404 for a correct secret sent without the Bearer scheme', async () => {
    expect((await route.GET(request({ authorization: SECRET }))).status).toBe(404);
    expect(mocks.runNotificationDelivery).not.toHaveBeenCalled();
  });

  it('answers 404 for a secret that is a prefix of the real one', async () => {
    const response = await route.GET(request({ authorization: `Bearer ${SECRET.slice(0, -1)}` }));

    expect(response.status).toBe(404);
    expect(mocks.runNotificationDelivery).not.toHaveBeenCalled();
  });

  it('drains for a correct secret', async () => {
    expect((await route.GET(authorized())).status).toBe(200);
    expect(mocks.runNotificationDelivery).toHaveBeenCalledTimes(1);
  });

  it('applies the same authorization to POST', async () => {
    expect((await route.POST(request())).status).toBe(404);
    expect((await route.POST(authorized())).status).toBe(200);
  });
});

describe('a failed run must not look like a successful one', () => {
  it('returns 200 for a healthy pass with an empty queue', async () => {
    mocks.runNotificationDelivery.mockResolvedValue(result({ status: 'idle' }));
    expect((await route.GET(authorized())).status).toBe(200);
  });

  it('returns 200 when work was drained', async () => {
    mocks.runNotificationDelivery.mockResolvedValue(
      result({ status: 'worked', claimed: 4, completed: 4, sent: 9 }),
    );

    const response = await route.GET(authorized());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ claimed: 4, completed: 4, sent: 9 });
  });

  it('returns 500 when the queue could not be read', async () => {
    mocks.runNotificationDelivery.mockResolvedValue(
      result({ status: 'failed', errorCode: '42501' }),
    );

    expect((await route.GET(authorized())).status).toBe(500);
  });

  it('returns 503 when nothing ran for want of configuration', async () => {
    mocks.runNotificationDelivery.mockResolvedValue(result({ status: 'skipped' }));

    expect((await route.GET(authorized())).status).toBe(503);
  });

  it('does NOT turn individual undeliverable notifications into a red cron', async () => {
    // A league with one stale endpoint would otherwise alarm every minute until
    // somebody stopped reading the alerts. The count is in the body for a
    // dashboard; the status code is about whether the *drain* worked.
    mocks.runNotificationDelivery.mockResolvedValue(
      result({ status: 'worked', claimed: 5, completed: 4, failed: 1 }),
    );

    const response = await route.GET(authorized());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ failed: 1 });
  });

  it('gives a failed run and an idle run different status codes', async () => {
    mocks.runNotificationDelivery.mockResolvedValue(result({ status: 'idle' }));
    const idle = await route.GET(authorized());

    mocks.runNotificationDelivery.mockResolvedValue(result({ status: 'failed', errorCode: 'x' }));
    const failed = await route.GET(authorized());

    expect(idle.status).not.toBe(failed.status);
  });
});

describe('the response body', () => {
  it('carries counts and a stable code, never a database message', async () => {
    mocks.runNotificationDelivery.mockResolvedValue(
      result({ status: 'failed', errorCode: '42501' }),
    );

    const body = (await (await route.GET(authorized())).json()) as Record<string, unknown>;

    expect(body).toEqual({
      status: 'failed',
      claimed: 0,
      completed: 0,
      failed: 0,
      sent: 0,
      errorCode: '42501',
    });
  });

  it('never echoes the secret', async () => {
    const response = await route.GET(authorized());
    const body = await response.text();

    expect(body).not.toContain(SECRET);
    expect(JSON.stringify([...response.headers])).not.toContain(SECRET);
  });
});

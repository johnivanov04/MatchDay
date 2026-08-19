import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { AccountDeletionRunResult } from '@/server/account-deletion';

/**
 * The reconciler's endpoint contract.
 *
 * Exercised at the route-handler level for the same reason the reminder one is:
 * the E2E server deliberately runs without a `CRON_SECRET`, which is what lets
 * that suite prove the endpoint does not exist without one. The authorized path
 * needs a configured secret, so it is proved here.
 *
 * The job behind it finishes deletions that stopped part-way — including the
 * state where Postgres is scrubbed and `auth.users` still holds the real email
 * address. That is not a deleted account, so the endpoint's job is to keep
 * trying and to be honest about failing.
 */

const mocks = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('@/server/account-deletion', () => ({
  runAccountDeletionReconciliation: mocks.run,
}));

const route = await import('@/app/api/cron/account-deletion/route');

const SECRET = 'test-cron-secret-value';
const ORIGINAL = process.env.CRON_SECRET;

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/cron/account-deletion', { method: 'GET', headers });
}

const authorized = () => request({ authorization: `Bearer ${SECRET}` });

function result(overrides: Partial<AccountDeletionRunResult> = {}): AccountDeletionRunResult {
  return { status: 'idle', found: 0, completed: 0, outstanding: 0, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  mocks.run.mockResolvedValue(result());
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
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('answers 404 without the bearer token', async () => {
    expect((await route.GET(request())).status).toBe(404);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('answers 404 for the wrong token', async () => {
    const response = await route.GET(request({ authorization: 'Bearer nope' }));

    // 404 rather than 401: an authorization failure that says "not found"
    // cannot be used to confirm the endpoint exists.
    expect(response.status).toBe(404);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('runs for the correct token', async () => {
    expect((await route.GET(authorized())).status).toBe(200);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('accepts POST as well, for a manual run', async () => {
    const response = await route.POST(
      new NextRequest('http://localhost/api/cron/account-deletion', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe('what the status code says', () => {
  it('reports a quiet pass as success', async () => {
    const response = await route.GET(authorized());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'idle', found: 0 });
  });

  it('reports a pass that finished something as success', async () => {
    mocks.run.mockResolvedValue(result({ status: 'worked', found: 2, completed: 2 }));

    expect((await route.GET(authorized())).status).toBe(200);
  });

  it('reports a failed listing as 500, so the platform counts it as a failure', async () => {
    mocks.run.mockResolvedValue(result({ status: 'failed' }));

    expect((await route.GET(authorized())).status).toBe(500);
  });

  it('reports a missing service-role key as 503, which is configuration not weather', async () => {
    mocks.run.mockResolvedValue(result({ status: 'skipped' }));

    expect((await route.GET(authorized())).status).toBe(503);
  });

  it('does not treat an account still waiting on GoTrue as a failed run', async () => {
    // An account waiting on a briefly unreachable Auth service is the system
    // working as designed. Alerting on it would train an operator to ignore the
    // alert; what matters is the number staying above zero across many passes,
    // which is a dashboard question rather than a status code.
    mocks.run.mockResolvedValue(result({ status: 'worked', found: 3, completed: 2, outstanding: 1 }));

    const response = await route.GET(authorized());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outstanding: 1 });
  });
});

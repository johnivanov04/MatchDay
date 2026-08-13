import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The health endpoint's contract, and the one thing it must never probe again.
 *
 * THE REGRESSION THIS FILE EXISTS TO PREVENT. The route originally read the
 * `leagues` base table through the anonymous client. `anon` holds no grant on
 * that table — only `authenticated` does — so PostgREST refused it with a 401
 * before Row Level Security was ever consulted, and every production health
 * check reported `{"status":"degraded","database":"unreachable"}` against a
 * completely healthy database.
 *
 * It passed locally because nothing exercised it. So the assertions below pin
 * the *target of the probe*, not merely the shape of the response — a fix that
 * only corrected the response would be no fix at all.
 *
 * `e2e/specs/phase7-mobile.spec.ts` is not where the end-to-end half lives; see
 * `phase5-inbox-reminders.spec.ts`, which hits the real route against the real
 * Supabase stack with the real anonymous key. That is the test that would
 * genuinely have caught this, because it exercises the grant.
 */

const mocks = vi.hoisted(() => ({ from: vi.fn(), select: vi.fn() }));

vi.mock('@/lib/supabase/anon', () => ({
  createSupabaseAnonClient: () => ({ from: mocks.from }),
}));

const route = await import('@/app/api/health/route');

/** The object anonymous discovery is deliberately allowed to read. */
const PUBLIC_PROJECTION = 'searchable_leagues_public';

/** The base table `anon` has no grant on. Probing it is the defect. */
const PROTECTED_TABLE = 'leagues';

function probeResolves(value: unknown) {
  mocks.select.mockReturnValue(Promise.resolve(value));
  mocks.from.mockReturnValue({ select: mocks.select });
}

beforeEach(() => {
  vi.clearAllMocks();
  probeResolves({ error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what the health check probes', () => {
  it('reads the anonymous-readable public projection', async () => {
    await route.GET();

    expect(mocks.from).toHaveBeenCalledWith(PUBLIC_PROJECTION);
  });

  it('never reads the protected leagues table', async () => {
    await route.GET();

    // `anon` cannot read it. Probing it makes the endpoint report a healthy
    // database as unreachable, which is exactly what happened in production.
    expect(mocks.from).not.toHaveBeenCalledWith(PROTECTED_TABLE);
  });

  it('probes exactly one object, so a second table cannot creep in', async () => {
    await route.GET();

    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it('asks for no rows at all', async () => {
    await route.GET();

    // `head: true` keeps row data off the wire entirely; the request either
    // succeeds or it does not.
    expect(mocks.select).toHaveBeenCalledWith('id', { count: 'exact', head: true });
  });
});

describe('the response contract', () => {
  it('answers 200 and ok when the probe succeeds', async () => {
    const response = await route.GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', database: 'ok' });
  });

  it('answers 503 and degraded when the probe returns an error', async () => {
    probeResolves({ error: { message: 'permission denied for table leagues' } });

    const response = await route.GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'degraded', database: 'unreachable' });
  });

  it('answers 503 when the client throws', async () => {
    mocks.from.mockImplementation(() => {
      throw new Error('connection refused to db.example.supabase.co');
    });

    const response = await route.GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'degraded', database: 'unreachable' });
  });

  it('is never cached', async () => {
    const response = await route.GET();

    // A cached health check reports the state of whichever instance answered
    // first, for as long as the cache lives.
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
  });
});

describe('the response reveals nothing', () => {
  it('carries exactly two fields', async () => {
    const body = (await (await route.GET()).json()) as Record<string, unknown>;

    // No version, no commit, no environment name, no counts. This endpoint is
    // unauthenticated, so anything it returns is public.
    expect(Object.keys(body).sort()).toEqual(['database', 'status']);
  });

  it('never echoes the probe error, which can name a table or a role', async () => {
    probeResolves({
      error: { message: 'permission denied for table leagues', code: '42501' },
    });

    const body = await (await route.GET()).text();

    expect(body).not.toContain('permission denied');
    expect(body).not.toContain('42501');
  });

  it('never echoes a thrown exception, which can name a host', async () => {
    mocks.from.mockImplementation(() => {
      throw new Error('getaddrinfo ENOTFOUND db.example.supabase.co');
    });

    const body = await (await route.GET()).text();

    expect(body).not.toContain('supabase.co');
    expect(body).not.toContain('ENOTFOUND');
  });
});

describe('the probe is bounded', () => {
  it('reports unreachable rather than hanging when the database never answers', async () => {
    vi.useFakeTimers();
    // A probe that never settles. Without the timeout the route would inherit
    // the platform's function timeout, and a watchdog cannot tell "slow" from
    // "gone".
    mocks.select.mockReturnValue(new Promise(() => {}));
    mocks.from.mockReturnValue({ select: mocks.select });

    const pending = route.GET();
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'degraded', database: 'unreachable' });
    vi.useRealTimers();
  });
});

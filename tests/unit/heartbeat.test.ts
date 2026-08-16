import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ObservabilityLog from '@/lib/observability/log';

/**
 * The heartbeat signaller.
 *
 * Two properties carry all the weight, and both are about restraint:
 *
 *   * it never throws, so a monitoring outage cannot become a reminder outage;
 *   * it never emits the URL, which embeds a token that would let anybody
 *     report this job healthy.
 */

const BASE = 'https://uptime.betterstack.test/api/v1/heartbeat/SECRET-TOKEN-abc123';
const TOKEN_FRAGMENT = 'SECRET-TOKEN-abc123';

const mocks = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/observability/log', async (importOriginal) => ({
  ...(await importOriginal<typeof ObservabilityLog>()),
  logInfo: mocks.logInfo,
  logWarn: mocks.logWarn,
  logError: mocks.logError,
}));

const { signalHeartbeat } = await import('@/lib/observability/heartbeat');

const ORIGINAL_URL = process.env.REMINDER_HEARTBEAT_URL;

/** Everything the module logged, flattened for scanning. */
function loggedText(): string {
  return JSON.stringify([
    ...mocks.logInfo.mock.calls,
    ...mocks.logWarn.mock.calls,
    ...mocks.logError.mock.calls,
  ]);
}

function requestedUrl(): string {
  return String((mocks.fetch.mock.calls[0] as [string, unknown] | undefined)?.[0] ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.REMINDER_HEARTBEAT_URL = BASE;
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.fetch.mockResolvedValue({ ok: true, status: 200 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_URL === undefined) {
    delete process.env.REMINDER_HEARTBEAT_URL;
  } else {
    process.env.REMINDER_HEARTBEAT_URL = ORIGINAL_URL;
  }
});

describe('which endpoint is pinged', () => {
  it('pings the base URL for a success', async () => {
    expect(await signalHeartbeat('success')).toBe('sent');

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(requestedUrl()).toBe(BASE);
  });

  it('appends /fail for a failure', async () => {
    expect(await signalHeartbeat('failure')).toBe('sent');

    expect(requestedUrl()).toBe(`${BASE}/fail`);
  });

  it('does not produce a double slash when the URL has a trailing one', async () => {
    process.env.REMINDER_HEARTBEAT_URL = `${BASE}/`;

    await signalHeartbeat('failure');

    // `…//fail` would not match the heartbeat at the provider.
    expect(requestedUrl()).toBe(`${BASE}/fail`);
    expect(requestedUrl()).not.toContain('//fail');
  });
});

describe('what is sent', () => {
  it('sends a bare GET with no body', async () => {
    await signalHeartbeat('success');

    const [, init] = mocks.fetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(init['method']).toBe('GET');
    // No payload at all is the guarantee that no PII, reminder content or
    // internal error text can ever reach the provider.
    expect(init['body']).toBeUndefined();
    expect(init['headers']).toBeUndefined();
  });

  it('bounds the request with a timeout signal', async () => {
    await signalHeartbeat('success');

    const [, init] = mocks.fetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(init['signal']).toBeDefined();
  });
});

describe('missing or unusable configuration', () => {
  it('does nothing when unset, and reports not_configured', async () => {
    delete process.env.REMINDER_HEARTBEAT_URL;

    expect(await signalHeartbeat('success')).toBe('not_configured');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('does nothing when blank', async () => {
    process.env.REMINDER_HEARTBEAT_URL = '   ';

    expect(await signalHeartbeat('success')).toBe('not_configured');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('treats an unparseable value as absent rather than throwing', async () => {
    process.env.REMINDER_HEARTBEAT_URL = 'not a url at all';

    expect(await signalHeartbeat('success')).toBe('invalid_url');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('refuses a non-HTTP scheme', async () => {
    for (const value of ['file:///etc/passwd', 'javascript:alert(1)']) {
      process.env.REMINDER_HEARTBEAT_URL = value;
      expect(await signalHeartbeat('success'), value).toBe('invalid_url');
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('provider failures are absorbed', () => {
  it('never throws on a non-2xx response', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 503 });

    await expect(signalHeartbeat('success')).resolves.toBe('http_error');
  });

  it('never throws on a transport error', async () => {
    mocks.fetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(signalHeartbeat('success')).resolves.toBe('network_error');
  });

  it('classifies a timeout distinctly', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    mocks.fetch.mockRejectedValue(timeout);

    await expect(signalHeartbeat('success')).resolves.toBe('timeout');
  });

  it('never throws even on a failure ping', async () => {
    mocks.fetch.mockRejectedValue(new Error('down'));

    await expect(signalHeartbeat('failure')).resolves.toBe('network_error');
  });
});

describe('the URL never leaks', () => {
  it('is absent from a successful ping log', async () => {
    await signalHeartbeat('success');

    expect(loggedText()).not.toContain(TOKEN_FRAGMENT);
    expect(loggedText()).not.toContain(BASE);
  });

  it('is absent when the provider returns an error status', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 500 });

    await signalHeartbeat('failure');

    expect(loggedText()).not.toContain(TOKEN_FRAGMENT);
    expect(loggedText()).toContain('http_error');
  });

  it('is absent when the transport error message embeds it', async () => {
    // `fetch` errors routinely quote the request URL.
    mocks.fetch.mockRejectedValue(new Error(`connect ECONNREFUSED for ${BASE}/fail`));

    await signalHeartbeat('failure');

    expect(loggedText()).not.toContain(TOKEN_FRAGMENT);
    expect(loggedText()).not.toContain('ECONNREFUSED');
  });

  it('is absent from the not-configured log', async () => {
    delete process.env.REMINDER_HEARTBEAT_URL;

    await signalHeartbeat('success');

    expect(loggedText()).not.toContain(TOKEN_FRAGMENT);
  });

  it('never returns the URL to the caller', async () => {
    const outcome = await signalHeartbeat('success');

    expect(String(outcome)).not.toContain(TOKEN_FRAGMENT);
    expect(typeof outcome).toBe('string');
  });
});

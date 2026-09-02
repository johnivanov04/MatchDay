import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ObservabilityLog from '@/lib/observability/log';

/**
 * The reminder worker's outcome contract.
 *
 * THE DEFECT THIS FILE EXISTS TO PREVENT: `runDueReminders()` used to return
 * `{claimed: 0, notified: 0, skipped: false}` both when nothing was due and
 * when the database call failed. A reminder pipeline could break and every
 * observable signal — the return value, the HTTP response, the logs — would be
 * byte-identical to a quiet Tuesday. A league would silently stop being
 * reminded and nobody would find out until players missed matches.
 *
 * So the assertions below are mostly about *distinguishability*, not about
 * counts.
 */

const mocks = vi.hoisted(() => ({
  isServiceRoleConfigured: vi.fn(),
  rpc: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
  isServiceRoleConfigured: mocks.isServiceRoleConfigured,
  createSupabaseAdminClient: () => ({ rpc: mocks.rpc }),
}));
// The writers are spied on; `assertLoggable` keeps its real implementation,
// because the whole point of the last section is to check keys against the
// actual filter rather than a stand-in for it.
vi.mock('@/lib/observability/log', async (importOriginal) => ({
  ...(await importOriginal<typeof ObservabilityLog>()),
  logInfo: mocks.logInfo,
  logWarn: mocks.logWarn,
  logError: mocks.logError,
}));

const { runDueReminders, reminderRunFailed } = await import('@/server/reminders');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isServiceRoleConfigured.mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** What the Supabase client returns for a successful `generate_due_reminders`. */
function claimed(rows: Array<{ reminder_id: string; notified: number }>) {
  return { data: rows, error: null };
}

describe('a failure is never mistaken for an empty run', () => {
  it('reports failure when the generator errors', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'denied' } });

    const result = await runDueReminders();

    expect(result.status).toBe('failed');
    expect(reminderRunFailed(result)).toBe(true);
  });

  it('reports idle when the generator succeeds with nothing due', async () => {
    mocks.rpc.mockResolvedValue(claimed([]));

    const result = await runDueReminders();

    expect(result.status).toBe('idle');
    expect(reminderRunFailed(result)).toBe(false);
  });

  it('produces different results for the two cases, not merely different labels', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'denied' } });
    const failure = await runDueReminders();

    vi.clearAllMocks();
    mocks.isServiceRoleConfigured.mockReturnValue(true);
    mocks.rpc.mockResolvedValue(claimed([]));
    const idle = await runDueReminders();

    // Both claim zero work. The whole point is that they are still
    // distinguishable — by an operator, a dashboard, and an alert rule.
    expect(failure.claimed).toBe(0);
    expect(idle.claimed).toBe(0);
    expect(failure).not.toEqual(idle);
    expect(failure.status).not.toBe(idle.status);
  });

  it('treats a null payload with no error object as a failure too', async () => {
    // Defensive: a client that returns neither data nor an error has not done
    // the work, and guessing that it meant "nothing due" is how the original
    // defect read.
    mocks.rpc.mockResolvedValue({ data: null, error: null });

    expect((await runDueReminders()).status).toBe('failed');
  });

  it('reports skipped, not idle, when no service-role key is configured', async () => {
    mocks.isServiceRoleConfigured.mockReturnValue(false);

    const result = await runDueReminders();

    expect(result.status).toBe('skipped');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('what the run logs', () => {
  it('logs an error, exactly once, when the generator fails', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'denied' } });

    await runDueReminders();

    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith('reminder.failed', { error_code: '42501' });
    expect(mocks.logInfo).not.toHaveBeenCalled();
  });

  it('never logs the database message, which can name another tenant', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates "leagues_slug_key" (rmvfc)' },
    });

    await runDueReminders();

    const logged = JSON.stringify(mocks.logError.mock.calls);
    expect(logged).not.toContain('rmvfc');
    expect(logged).not.toContain('leagues_slug_key');
    expect(logged).toContain('23505');
  });

  it('logs counts on a successful run', async () => {
    mocks.rpc.mockResolvedValue(
      claimed([
        { reminder_id: 'r1', notified: 3 },
        { reminder_id: 'r2', notified: 2 },
      ]),
    );

    const result = await runDueReminders();

    expect(result).toMatchObject({ status: 'worked', claimed: 2, notified: 5 });
    expect(mocks.logInfo).toHaveBeenCalledWith('reminder.run', {
      claimed: 2,
      notified: 5,
    });
  });

  it('warns rather than failing when a misconfiguration stops the run', async () => {
    mocks.isServiceRoleConfigured.mockReturnValue(false);

    await runDueReminders();

    expect(mocks.logWarn).toHaveBeenCalledWith('reminder.skipped', {
      service_role_configured: false,
    });
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('logs no identifying detail about any player or league', async () => {
    mocks.rpc.mockResolvedValue(claimed([{ reminder_id: 'r1', notified: 1 }]));

    await runDueReminders();

    const logged = JSON.stringify([
      ...mocks.logInfo.mock.calls,
      ...mocks.logWarn.mock.calls,
      ...mocks.logError.mock.calls,
    ]);
    for (const field of ['email', 'first_name', 'last_name', 'phone', 'title', 'slug']) {
      expect(logged).not.toContain(field);
    }
  });
});

describe('the reminder worker no longer delivers anything itself', () => {
  // Phase 3B moved delivery behind the durable queue. What this module owes is
  // the canonical notifications; the trigger enqueues them in the same
  // transaction, and `/api/cron/notification-delivery` drains the queue.
  //
  // The property worth pinning is negative and easy to lose: a reminder pass
  // must make NO provider call. If someone reintroduces an inline dispatch,
  // reminder generation goes back to being bounded by Apple's response time
  // inside a function with a wall clock.
  it('imports no push transport at all', async () => {
    const source = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '../../src/server/reminders.ts'),
      'utf8',
    );

    for (const forbidden of ['push/notify', 'push/dispatch', 'push/sender', 'push/apns']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('reports a run without any push bookkeeping in its result', async () => {
    mocks.rpc.mockResolvedValue(claimed([{ reminder_id: 'r1', notified: 4 }]));

    const result = await runDueReminders();

    expect(result).toEqual({ status: 'worked', claimed: 1, notified: 4, errorCode: null });
    expect(result).not.toHaveProperty('pushFailures');
  });
});

describe('every field these events emit actually reaches the log line', () => {
  // The logger drops any key whose name contains a forbidden substring, and it
  // does so SILENTLY. `reminder.skipped` originally carried `reason`, which is
  // on that list, so the one field explaining why nothing ran never appeared.
  // These assertions pin every key this module emits.
  it('emits only loggable keys', async () => {
    const { assertLoggable } = await import('@/lib/observability/log');

    mocks.rpc.mockResolvedValue(claimed([{ reminder_id: 'r1', notified: 1 }]));
    await runDueReminders();

    mocks.isServiceRoleConfigured.mockReturnValue(false);
    await runDueReminders();

    mocks.isServiceRoleConfigured.mockReturnValue(true);
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501' } });
    await runDueReminders();

    const everyCall = [
      ...mocks.logInfo.mock.calls,
      ...mocks.logWarn.mock.calls,
      ...mocks.logError.mock.calls,
    ];
    expect(everyCall.length).toBeGreaterThan(0);

    for (const [event, fields] of everyCall) {
      expect(assertLoggable(fields as ObservabilityLog.LogFields), `${String(event)}`).toBe(true);
    }
  });
});

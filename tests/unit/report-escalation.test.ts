import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ObservabilityLog from '@/lib/observability/log';
import type * as SupabaseAdmin from '@/lib/supabase/admin';
import type { EmailSendOutcome, EmailSender } from '@/lib/email/resend';
import type { UnescalatedReportRow } from '@/types/database';

/**
 * The escalation worker's contract.
 *
 * Guideline 1.2 asks for timely responses, and the only mechanism standing
 * behind that promise is this. So the properties worth pinning are the ones
 * that would let a report go quiet: a claim that fails must not look idle, a
 * send that fails must not look successful, and a missing destination must be
 * reported rather than swallowed.
 *
 * The other property is a privacy one. An escalation lands in a mailbox and
 * passes through a mail provider, both of which retain it — so the digest must
 * carry the pointer and never the substance.
 */

const mocks = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  rpc: vi.fn(),
  isServiceRoleConfigured: vi.fn(() => true),
}));

vi.mock('@/lib/observability/log', async (importOriginal) => ({
  ...(await importOriginal<typeof ObservabilityLog>()),
  logInfo: mocks.logInfo,
  logError: mocks.logError,
}));

vi.mock('@/lib/supabase/admin', async (importOriginal) => ({
  ...(await importOriginal<typeof SupabaseAdmin>()),
  isServiceRoleConfigured: mocks.isServiceRoleConfigured,
  createSupabaseAdminClient: () => ({ rpc: mocks.rpc }),
}));

const { runReportEscalation } = await import('@/server/report-escalation');

function report(index: number): UnescalatedReportRow {
  return {
    report_id: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`,
    target_type: 'user',
    reason: 'harassment',
    created_at: '2026-09-20T10:00:00.000Z',
  };
}

function senderReturning(outcome: EmailSendOutcome): EmailSender & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
      return outcome;
    },
  };
}

describe('report escalation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isServiceRoleConfigured.mockReturnValue(true);
  });

  it('sends one digest for a batch of reports', async () => {
    mocks.rpc.mockResolvedValue({ data: [report(1), report(2), report(3)], error: null });
    const sender = senderReturning({ ok: true });

    const result = await runReportEscalation({ sender, supportAddress: 'ops@example.test' });

    expect(result).toEqual({ status: 'worked', claimed: 3, sent: 1 });
    expect(sender.sent).toHaveLength(1);
  });

  it('reports an empty queue as idle rather than worked', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    const sender = senderReturning({ ok: true });

    const result = await runReportEscalation({ sender, supportAddress: 'ops@example.test' });

    expect(result.status).toBe('idle');
    expect(sender.sent).toHaveLength(0);
  });

  it('does not report a failed claim as an empty queue', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const sender = senderReturning({ ok: true });

    const result = await runReportEscalation({ sender, supportAddress: 'ops@example.test' });

    expect(result.status).toBe('failed');
    expect(mocks.logError).toHaveBeenCalled();
  });

  it('does not report a failed send as a successful run', async () => {
    mocks.rpc.mockResolvedValue({ data: [report(1)], error: null });
    const sender = senderReturning({ ok: false, statusCode: 500 });

    const result = await runReportEscalation({ sender, supportAddress: 'ops@example.test' });

    expect(result.status).toBe('failed');
    expect(result.sent).toBe(0);
    // Loud, because reports that look handled and are not is the failure this
    // whole path exists to prevent.
    expect(mocks.logError).toHaveBeenCalled();
  });

  it('skips, and says so, when there is nowhere to send', async () => {
    const result = await runReportEscalation({ sender: null, supportAddress: 'ops@example.test' });
    expect(result.status).toBe('skipped');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('skips when no support address is configured', async () => {
    const sender = senderReturning({ ok: true });
    const result = await runReportEscalation({ sender, supportAddress: null });
    expect(result.status).toBe('skipped');
    expect(sender.sent).toHaveLength(0);
  });

  it('skips without a service-role key rather than claiming work it cannot mark', async () => {
    mocks.isServiceRoleConfigured.mockReturnValue(false);
    const sender = senderReturning({ ok: true });
    const result = await runReportEscalation({ sender, supportAddress: 'ops@example.test' });
    expect(result.status).toBe('skipped');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  describe('the digest carries a pointer, not the substance', () => {
    it('contains the report id, kind and reason, and nothing identifying', async () => {
      mocks.rpc.mockResolvedValue({ data: [report(7)], error: null });
      const sender = senderReturning({ ok: true });

      await runReportEscalation({ sender, supportAddress: 'ops@example.test' });

      const message = sender.sent[0] as { rendered: { text: string; html: string } };
      const body = `${message.rendered.text}\n${message.rendered.html}`;

      expect(body).toContain('44444444-4444-4444-8444-000000000007');
      expect(body).toContain('harassment');

      // The property is not "the word reporter is absent" — the instructions
      // say to go and read the reporter in the database, which is the point.
      // It is that no IDENTITY travels: the only uuid in the message is the
      // report's own, and there is no address anywhere.
      const uuids = new Set(body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []);
      expect([...uuids]).toEqual(['44444444-4444-4444-8444-000000000007']);
      expect(body).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    });

    it('uses a deterministic idempotency key so a retried pass cannot double-send', async () => {
      mocks.rpc.mockResolvedValue({ data: [report(1), report(2)], error: null });
      const first = senderReturning({ ok: true });
      const second = senderReturning({ ok: true });

      await runReportEscalation({ sender: first, supportAddress: 'ops@example.test' });
      await runReportEscalation({ sender: second, supportAddress: 'ops@example.test' });

      const keyOf = (s: { sent: unknown[] }) =>
        (s.sent[0] as { idempotencyKey: string }).idempotencyKey;
      expect(keyOf(first)).toBe(keyOf(second));
    });
  });

  it('emits only loggable keys', async () => {
    mocks.rpc.mockResolvedValue({ data: [report(1)], error: null });
    const sender = senderReturning({ ok: true });
    await runReportEscalation({ sender, supportAddress: 'ops@example.test' });

    const { assertLoggable } = await import('@/lib/observability/log');
    for (const call of mocks.logInfo.mock.calls) {
      expect(assertLoggable(call[1] as Parameters<typeof assertLoggable>[0])).toBe(true);
    }
  });
});

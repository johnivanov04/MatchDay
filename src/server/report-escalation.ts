import 'server-only';

import { getSupportEmail } from '@/lib/env';
import { createResendSender, readEmailConfiguration, type EmailSender } from '@/lib/email/resend';
import { logError, logInfo } from '@/lib/observability/log';
import { createSupabaseAdminClient, isServiceRoleConfigured } from '@/lib/supabase/admin';
import type { UnescalatedReportRow } from '@/types/database';

/**
 * Puts new reports in front of a human.
 *
 * ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────
 *
 * Guideline 1.2 asks for a reporting mechanism *and* timely responses. A table
 * that fills up unread satisfies the first and fails the second, and "somebody
 * will check the dashboard" is not an operational path — it is a hope. This
 * runs on the same cron as everything else and makes an unread report
 * impossible to accumulate quietly.
 *
 * ── WHAT THE EMAIL CONTAINS, AND WHY IT IS SO THIN ─────────────────────────
 *
 * The report id, what kind of thing was reported, the stated reason, and when.
 * Not who reported it, not who was reported, and not one character of the
 * reported text. An escalation email lands in a mailbox, passes through a mail
 * provider, and is retained by both — so it carries the *pointer* and the
 * operator reads the substance from the database, authenticated. That is also
 * why a single digest goes out rather than one message per report: the volume
 * of reports about a member is itself information about that member.
 */

export interface ReportEscalationResult {
  status: 'worked' | 'idle' | 'skipped' | 'failed';
  claimed: number;
  sent: number;
  errorCode?: string;
}

export interface ReportEscalationDependencies {
  sender?: EmailSender | null;
  supportAddress?: string | null;
}

function renderDigest(rows: readonly UnescalatedReportRow[]): { subject: string; text: string; html: string } {
  const lines = rows.map(
    (row) =>
      `• ${row.target_type} · ${row.reason} · ${new Date(row.created_at).toISOString()} · id ${row.report_id}`,
  );

  const subject =
    rows.length === 1 ? 'MatchDay: 1 new content report' : `MatchDay: ${rows.length} new content reports`;

  const text = [
    rows.length === 1
      ? 'One new report was filed in MatchDay.'
      : `${rows.length} new reports were filed in MatchDay.`,
    '',
    ...lines,
    '',
    'Open each report in the database to see the reporter, the target and any detail.',
    'Resolve with resolve_content_report(id, status, note).',
  ].join('\n');

  // Escaped by construction: every interpolated value is an enum label, an ISO
  // timestamp or a UUID, all produced by the database rather than by a member.
  const html = [
    '<p>',
    rows.length === 1
      ? 'One new report was filed in MatchDay.'
      : `${rows.length} new reports were filed in MatchDay.`,
    '</p><ul>',
    ...rows.map(
      (row) =>
        `<li><strong>${row.target_type}</strong> — ${row.reason} — ${new Date(
          row.created_at,
        ).toISOString()} — <code>${row.report_id}</code></li>`,
    ),
    '</ul><p>Open each report in the database for the reporter, the target and any detail.</p>',
  ].join('');

  return { subject, text, html };
}

export async function runReportEscalation(
  dependencies: ReportEscalationDependencies = {},
): Promise<ReportEscalationResult> {
  const supportAddress = dependencies.supportAddress ?? getSupportEmail();
  const configuration = readEmailConfiguration();
  const sender =
    dependencies.sender !== undefined
      ? dependencies.sender
      : configuration === null
        ? null
        : createResendSender(configuration);

  // Nowhere to send and nothing to send with: reports keep accumulating and
  // stay unescalated, which is the honest state rather than a silent success.
  if (!isServiceRoleConfigured() || sender === null || supportAddress === null) {
    logInfo('report_escalation.run', {
      status: 'skipped',
      service_role_configured: isServiceRoleConfigured(),
      transport_configured: sender !== null,
      destination_configured: supportAddress !== null,
    });
    return { status: 'skipped', claimed: 0, sent: 0 };
  }

  const supabase = createSupabaseAdminClient();

  const { data, error } = await supabase.rpc('claim_unescalated_reports', { p_limit: 50 });

  if (error !== null) {
    logError('report_escalation.run', { status: 'failed', claimed: 0, sent: 0 });
    return { status: 'failed', claimed: 0, sent: 0, errorCode: 'claim_failed' };
  }

  const rows = (data ?? []) as UnescalatedReportRow[];

  if (rows.length === 0) {
    logInfo('report_escalation.run', { status: 'idle', claimed: 0, sent: 0 });
    return { status: 'idle', claimed: 0, sent: 0 };
  }

  const rendered = renderDigest(rows);

  const outcome = await sender.send({
    to: supportAddress,
    rendered,
    // One digest per batch. The oldest report's id makes the key deterministic,
    // so a retried cron pass cannot send the same digest twice.
    idempotencyKey: `matchday/report-escalation/${rows[0]?.report_id ?? 'empty'}/v1`,
  });

  // A failed escalation is an ERROR, not an info line. Reports that look
  // handled and are not is the exact failure this whole path exists to prevent.
  const log = outcome.ok ? logInfo : logError;
  log('report_escalation.run', {
    status: outcome.ok ? 'worked' : 'failed',
    claimed: rows.length,
    sent: outcome.ok ? 1 : 0,
  });

  // The reports are already marked escalated by the claim. A failed send is
  // reported as a failed run — loudly, because the alternative is reports that
  // look handled and are not.
  return outcome.ok
    ? { status: 'worked', claimed: rows.length, sent: 1 }
    : { status: 'failed', claimed: rows.length, sent: 0, errorCode: 'send_failed' };
}

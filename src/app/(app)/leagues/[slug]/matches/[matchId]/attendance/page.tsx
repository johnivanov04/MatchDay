import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AttendanceWorkspace } from '@/components/attendance-workspace';
import {
  dashboardPathWithNotice,
  DASHBOARD_NOTICES,
  matchPath,
  requireLeagueAdminPage,
} from '@/lib/auth/page-guards';
import { getAttendanceWorkspace, matchAcceptsAttendance } from '@/lib/matches/attendance';
import { getMatch } from '@/lib/matches/matches';
import { ClipboardIcon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Attendance' };

/**
 * Administrator-only attendance register.
 *
 * The guards follow the pattern Phases 2–6 settled on and every failure is a
 * redirect: an ordinary error escaping a Server Component is reported by
 * Next.js as an unhandled application error, which is what a player following a
 * shared link would otherwise see.
 *
 * "Not yet finished" is a rendered explanation rather than a redirect. An
 * administrator arriving before the final whistle has come to the right place
 * at the wrong time, and bouncing them to the dashboard with a generic notice
 * would tell them nothing about when to come back.
 */
export default async function MatchAttendancePage({
  params,
}: {
  params: Promise<{ slug: string; matchId: string }>;
}) {
  const { slug, matchId } = await params;
  const { league } = await requireLeagueAdminPage(slug);

  const match = await getMatch(league.id, matchId);
  if (match === null) {
    redirect(dashboardPathWithNotice(DASHBOARD_NOTICES.notLeagueAdmin));
  }

  const [open, entries] = await Promise.all([
    matchAcceptsAttendance(matchId),
    getAttendanceWorkspace(matchId),
  ]);

  return (
    <>
      <PageHeader
        eyebrow={league.name}
        icon={<ClipboardIcon size={13} />}
        title="Attendance"
        description={match.title}
        back={{ href: matchPath(slug, matchId), label: 'Back to the match' }}
      />

      {match.status === 'canceled' ? (
        <p
          role="status"
          className="rounded-lg border border-whistle-200 bg-whistle-50 px-3 py-2 text-sm text-red-800 dark:border-whistle-900 dark:bg-whistle-900/25 dark:text-red-200"
        >
          This match was canceled, so there is no attendance to record.
        </p>
      ) : open ? (
        <AttendanceWorkspace
          leagueId={league.id}
          matchId={match.id}
          entries={entries}
          completed={match.status === 'completed'}
        />
      ) : (
        <section className="surface-card p-4">
          <p className="text-sm text-muted">
            Attendance can be recorded once the match has finished. Come back after{' '}
            {new Date(match.end_at).toLocaleString('en-GB', {
              weekday: 'short',
              day: '2-digit',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
              timeZone: match.timezone,
            })}
            .
          </p>
        </section>
      )}
    </>
  );
}

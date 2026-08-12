import type { Metadata } from 'next';
import Link from 'next/link';
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
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-muted">{league.name}</p>
        <h1 className="text-2xl font-bold">Attendance</h1>
        <p className="text-sm text-muted">{match.title}</p>
        <Link href={matchPath(slug, matchId)} className="mt-1 text-sm underline underline-offset-4">
          Back to the match
        </Link>
      </header>

      {match.status === 'canceled' ? (
        <p
          role="status"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200"
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

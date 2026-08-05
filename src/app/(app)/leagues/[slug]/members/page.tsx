import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AddMemberForm,
  CreateInviteForm,
  InviteRow,
  JoinRequestRow,
  MemberRow,
  TransferAdministrationForm,
} from '@/components/member-management';
import { requireLeagueAdminPage } from '@/lib/auth/page-guards';
import {
  describeInvite,
  getLeagueInvites,
  getLeagueMembers,
  getPendingJoinRequests,
} from '@/lib/leagues/league-admin';

export const metadata: Metadata = { title: 'Members' };

export default async function LeagueMembersPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // A former administrator who is still sitting on this route after handing the
  // league over is redirected to the dashboard, not shown an error.
  const { user, league } = await requireLeagueAdminPage(slug);

  const [members, requests, invites] = await Promise.all([
    getLeagueMembers(league.id),
    getPendingJoinRequests(league.id),
    getLeagueInvites(league.id),
  ]);

  // Only an active player can receive administration — the database enforces
  // the same rule, so an option outside this list would be rejected anyway.
  const transferCandidates = members.filter(
    (entry) => entry.membership.status === 'active' && entry.membership.role === 'player',
  );

  const visibleMembers = members.filter((entry) => entry.membership.status !== 'removed');
  const removedCount = members.length - visibleMembers.length;

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-muted">{league.name}</p>
        <h1 className="text-2xl font-bold">Members</h1>
        <Link
          href={`/leagues/${league.slug}/settings`}
          className="mt-1 text-sm font-semibold underline underline-offset-4"
        >
          League settings
        </Link>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">
          Join requests {requests.length > 0 ? `(${requests.length})` : ''}
        </h2>
        {requests.length === 0 ? (
          <p className="text-sm text-muted">
            {league.visibility === 'private'
              ? 'This league is private, so it receives no join requests. People join by invitation.'
              : 'No pending requests.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {requests.map((entry) => (
              <JoinRequestRow key={entry.request.id} entry={entry} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">Members ({visibleMembers.length})</h2>
        <ul className="flex flex-col gap-2">
          {visibleMembers.map((entry) => (
            <MemberRow
              key={entry.membership.id}
              entry={entry}
              leagueId={league.id}
              isSelf={entry.membership.user_id === user.id}
            />
          ))}
        </ul>
        {removedCount > 0 ? (
          <p className="text-xs text-muted">
            {removedCount} removed {removedCount === 1 ? 'member is' : 'members are'} kept on record
            and hidden here.
          </p>
        ) : null}
      </section>

      <section className="surface-card flex flex-col gap-3 p-4">
        <h2 className="text-base font-semibold">Add a member directly</h2>
        <AddMemberForm leagueId={league.id} />
      </section>

      <section className="surface-card flex flex-col gap-3 p-4">
        <h2 className="text-base font-semibold">Invitation links</h2>
        <p className="text-sm text-muted">
          Anyone with the link can join until it expires, is used up, or you revoke it.
        </p>
        <CreateInviteForm leagueId={league.id} />

        {invites.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-2">
            {invites.map((invite) => (
              <InviteRow
                key={invite.id}
                invite={invite}
                inviteState={describeInvite(invite)}
                expiresLabel={new Date(invite.expires_at).toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
                leagueId={league.id}
              />
            ))}
          </ul>
        ) : null}
      </section>

      <section className="surface-card flex flex-col gap-3 p-4">
        <h2 className="text-base font-semibold">Transfer administration</h2>
        <p className="text-sm text-muted">
          A league has exactly one administrator. Handing it over makes you an ordinary player here
          and cannot be undone by you afterwards.
        </p>
        <TransferAdministrationForm leagueId={league.id} candidates={transferCandidates} />
      </section>
    </>
  );
}

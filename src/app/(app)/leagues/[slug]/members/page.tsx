import type { Metadata } from 'next';
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
import { ButtonLink } from '@/components/ui/button';
import { Card, Section } from '@/components/ui/card';
import { SettingsIcon, UsersIcon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/status';

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
      <PageHeader
        eyebrow={league.name}
        icon={<UsersIcon size={13} />}
        title="Members"
        description="Everybody in this league, plus the requests and invitations waiting on you."
        actions={
          <ButtonLink href={`/leagues/${league.slug}/settings`} icon={<SettingsIcon size={16} />}>
            League settings
          </ButtonLink>
        }
      />

      {/* Requests come first, and only when there are any: this is the one
          thing on the screen that is waiting on the administrator, and burying
          it under a forty-row member list is how a join request sits unanswered
          for a week. */}
      {requests.length > 0 ? (
        <Section
          title={`Join requests (${String(requests.length)})`}
          description="Waiting on your decision."
        >
          <ul className="stagger flex flex-col gap-2">
            {requests.map((entry) => (
              <JoinRequestRow key={entry.request.id} entry={entry} />
            ))}
          </ul>
        </Section>
      ) : null}

      <Section
        title={`Members (${String(visibleMembers.length)})`}
        description="Reasons are visible only to administrators. Suspending or removing somebody also releases the spots they hold in matches that have not been played yet, and a suspend-until date is a note to yourself — nothing happens automatically on it."
      >
        {visibleMembers.length === 0 ? (
          <EmptyState
            icon={<UsersIcon size={22} />}
            title="Nobody here yet"
            description="Add somebody by email, or create an invitation link and send it to the group."
          />
        ) : (
          <ul className="stagger flex flex-col gap-2">
            {visibleMembers.map((entry) => (
              <MemberRow
                key={entry.membership.id}
                entry={entry}
                leagueId={league.id}
                isSelf={entry.membership.user_id === user.id}
              />
            ))}
          </ul>
        )}
        {removedCount > 0 ? (
          <p className="text-xs text-muted">
            {removedCount} removed {removedCount === 1 ? 'member is' : 'members are'} kept on record
            and hidden here.
          </p>
        ) : null}
        {requests.length === 0 && league.visibility === 'private' ? (
          <p className="text-xs text-muted">
            This league is private, so it receives no join requests. People join by invitation.
          </p>
        ) : null}
      </Section>

      <Section title="Add a member directly">
        <Card className="p-4">
          <AddMemberForm leagueId={league.id} />
        </Card>
      </Section>

      <Section
        title="Invitation links"
        description="Anyone with the link can join until it expires, is used up, or you revoke it."
      >
        <Card className="flex flex-col gap-3 p-4">
          <CreateInviteForm leagueId={league.id} />

          {invites.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-2">
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
        </Card>
      </Section>

      <Section
        title="Transfer administration"
        description="A league has exactly one administrator. Handing it over makes you an ordinary player here and cannot be undone by you afterwards."
      >
        <Card className="p-4">
          <TransferAdministrationForm leagueId={league.id} candidates={transferCandidates} />
        </Card>
      </Section>
    </>
  );
}

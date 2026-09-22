import type { Metadata } from 'next';
import { BlockedMembers } from '@/components/blocked-members';
import { Card, Section } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/status';
import { requireOnboardedUser } from '@/lib/auth/page-guards';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { BlockedMemberRow } from '@/types/database';

export const metadata: Metadata = { title: 'Blocked members' };

/**
 * Who you have blocked, and the way back.
 *
 * A block has to be reversible somewhere, and "somewhere" cannot be the roster
 * it removed the person from — once a name reads "Blocked member", the roster
 * has stopped being a place you can find them. So the list lives here, and it
 * is the only screen that shows a blocked member's real name, because the
 * person who blocked them is the one person entitled to see it.
 */
export default async function BlockedMembersPage() {
  await requireOnboardedUser();

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.rpc('my_blocked_members');
  const blocked = (data ?? []) as BlockedMemberRow[];

  return (
    <>
      <PageHeader title="Blocked members" />
      <Section>
        <Card>
          {blocked.length === 0 ? (
            <EmptyState
              title="You have not blocked anyone"
              description="You can block a member from any roster or team sheet they appear on."
            />
          ) : (
            <BlockedMembers members={blocked} />
          )}
        </Card>
      </Section>
    </>
  );
}

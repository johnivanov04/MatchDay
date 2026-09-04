import type { Metadata } from 'next';
import { EmailNotificationsToggle } from '@/components/email-notifications-toggle';
import { NotificationTypePreferences } from '@/components/notification-type-preferences';
import { requireOnboardedUser } from '@/lib/auth/page-guards';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/ui/page-header';

/**
 * The email channel switch.
 *
 * Read under the caller's own session, so RLS is what decides whose preference
 * this is — the query does not filter by user id and does not need to. A member
 * who somehow asked for another row would get nothing back rather than
 * somebody else's setting.
 *
 * No row means off. That is the whole reason Phase 3D could ship without
 * emailing every existing member, and it is why this page never creates one
 * just by being visited.
 */
export const metadata: Metadata = { title: 'Email notifications' };

export default async function NotificationSettingsPage() {
  await requireOnboardedUser();

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('notification_preferences')
    .select('email_enabled')
    .maybeSingle();

  const emailEnabled = data?.email_enabled ?? false;

  // Sparse: only the overrides this member has actually set. Everything absent
  // is on, which is what the delivery worker does, so the page shows the truth
  // without writing a row just by being visited.
  const { data: overrideRows } = await supabase
    .from('notification_type_preferences')
    .select('notification_type, channel, enabled');

  const overrides: Record<string, boolean> = {};
  for (const row of overrideRows ?? []) {
    overrides[`${row.notification_type}:${row.channel}`] = row.enabled;
  }

  return (
    <>
      <PageHeader
        title="Email notifications"
        description="Get the same match alerts by email. These are transactional notifications about your leagues and matches — never marketing. Everything also stays in your in-app inbox, so turning this off loses nothing."
      />

      <section className="mt-6 max-w-2xl rounded-lg border border-line p-4">
        <EmailNotificationsToggle enabled={emailEnabled} />
      </section>

      <section className="max-w-2xl">
        <NotificationTypePreferences emailEnabled={emailEnabled} overrides={overrides} />
      </section>
    </>
  );
}

import type { Metadata } from 'next';
import { DeviceRow, EnablePushButton } from '@/components/push-devices';
import { requireOnboardedUser } from '@/lib/auth/page-guards';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { PushSubscriptionRow } from '@/types/database';
import { PageHeader } from '@/components/ui/page-header';
import { isNativeIOSApp } from '@/lib/platform/native-server';

export const metadata: Metadata = { title: 'Phone notifications' };

/**
 * Device management for Web Push.
 *
 * Note what is read: labels, state and timestamps. The endpoint and keys are not
 * selected — and could not be, because `authenticated` holds no privilege on
 * those columns. A user identifies a device by its label, never by its
 * credential.
 *
 * The VAPID **public** key is passed to the browser deliberately; that is what
 * it is for. The private key is read only inside the server-only push modules.
 */
export default async function DevicesPage() {
  // The guard first, always: nothing should be computed for a caller who is
  // about to be redirected.
  await requireOnboardedUser();
  const isNativeApp = await isNativeIOSApp();

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('push_subscriptions')
    .select(
      'id, user_id, device_label, enabled, created_at, updated_at, last_seen_at, last_success_at, consecutive_failures, disabled_reason',
    )
    .order('created_at', { ascending: false });

  const devices: PushSubscriptionRow[] = data ?? [];
  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null;

  return (
    <>
      <PageHeader
        title="Phone notifications"
        description="Get match alerts on your phone even when MatchDay is closed. Everything also stays in your in-app inbox, so turning this off loses nothing."
        back={{ href: '/profile', label: 'Back to your profile' }}
      />

      <section className="surface-card flex flex-col gap-3 p-4">
        <h2 className="text-[0.9375rem] font-semibold">This device</h2>
        {vapidPublicKey === null ? (
          <p className="text-sm text-muted">
            Phone notifications are not configured on this deployment. Your in-app inbox works
            normally.
          </p>
        ) : (
          <EnablePushButton vapidPublicKey={vapidPublicKey} isNativeApp={isNativeApp} />
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[0.9375rem] font-semibold">Your devices ({devices.length})</h2>
        {devices.length === 0 ? (
          <p className="text-sm text-muted">No devices are registered yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {devices.map((device) => (
              <DeviceRow key={device.id} device={device} />
            ))}
          </ul>
        )}
      </section>

      <section className="surface-card p-4">
        <h2 className="text-[0.9375rem] font-semibold">What gets sent to your phone</h2>
        <ul className="mt-2 list-disc pl-5 text-sm text-muted">
          <li>A match is published, changed or canceled</li>
          <li>Your request to join a league is approved or declined</li>
          <li>A league publishes guidelines you need to accept</li>
        </ul>
        <p className="mt-2 text-xs text-muted">
          Alerts carry only the league and match name and the time. Member lists, rosters and
          anything private stay inside the app.
        </p>
      </section>
    </>
  );
}

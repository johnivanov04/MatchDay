import type { Metadata } from 'next';
import { MarkAllReadButton, NotificationRowItem } from '@/components/notification-inbox';
import { BellIcon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/status';
import { requireOnboardedUser } from '@/lib/auth/page-guards';
import { getMyNotifications, getUnreadNotificationCount } from '@/lib/notifications/notifications';

export const metadata: Metadata = { title: 'Notifications' };

/**
 * The canonical inbox — the source of truth for every alert.
 *
 * Everything appears here whether or not push is enabled, whether or not it was
 * delivered, and whether or not the browser supports notifications at all. That
 * is what makes Web Push a delivery channel rather than a second store.
 */
export default async function NotificationsPage() {
  await requireOnboardedUser();

  const [notifications, unreadCount] = await Promise.all([
    getMyNotifications(),
    getUnreadNotificationCount(),
  ]);

  return (
    <>
      <PageHeader
        title="Notifications"
        description={
          unreadCount === 0
            ? 'You are all caught up.'
            : `${unreadCount} unread ${unreadCount === 1 ? 'notification' : 'notifications'}.`
        }
        actions={<MarkAllReadButton unreadCount={unreadCount} />}
      />

      {notifications.length === 0 ? (
        <EmptyState
          icon={<BellIcon size={22} />}
          title="No notifications yet"
          description="Match reminders, roster decisions and team sheets land here. Everything stays in this inbox even if you turn phone alerts off."
        />
      ) : (
        <ul className="stagger flex flex-col gap-3">
          {notifications.map((notification) => (
            <NotificationRowItem key={notification.id} notification={notification} />
          ))}
        </ul>
      )}
    </>
  );
}

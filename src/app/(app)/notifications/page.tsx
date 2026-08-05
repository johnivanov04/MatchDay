import type { Metadata } from 'next';
import { MarkAllReadButton, NotificationRowItem } from '@/components/notification-inbox';
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
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">Notifications</h1>
        <p className="text-sm text-muted">
          {unreadCount === 0
            ? 'You are all caught up.'
            : `${unreadCount} unread ${unreadCount === 1 ? 'notification' : 'notifications'}.`}
        </p>
        <MarkAllReadButton unreadCount={unreadCount} />
      </header>

      {notifications.length === 0 ? (
        <p className="text-sm text-muted">Nothing here yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {notifications.map((notification) => (
            <NotificationRowItem key={notification.id} notification={notification} />
          ))}
        </ul>
      )}
    </>
  );
}

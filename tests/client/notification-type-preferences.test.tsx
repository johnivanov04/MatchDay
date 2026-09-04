import { describe, expect, it, vi } from 'vitest';
import { render } from './helpers/render';

vi.mock('@/server/actions/notification-preferences', () => ({
  setNotificationTypePreferenceAction: vi.fn(),
  setEmailNotificationsEnabledAction: vi.fn(),
}));

const { NotificationTypePreferences } = await import('@/components/notification-type-preferences');
const { CONFIGURABLE_NOTIFICATION_TYPES, NOTIFICATION_TYPE_META } = await import(
  '@/lib/notifications/notification-types'
);

/**
 * The per-type matrix.
 *
 * The property that matters most is the default: a member with no override rows
 * must see everything switched on, because that is what the delivery worker
 * will do. A page that showed "Off" for an absent row would be lying about
 * what happens next.
 */

describe('NotificationTypePreferences', () => {
  it('shows every configurable type and no in-app-only one', async () => {
    const { container, unmount } = await render(
      <NotificationTypePreferences emailEnabled overrides={{}} />,
    );

    const html = container.innerHTML;
    for (const type of CONFIGURABLE_NOTIFICATION_TYPES) {
      expect(html, type).toContain(NOTIFICATION_TYPE_META[type].label);
    }
    // Attendance is in-app only and must not appear as a switchable row.
    expect(html).not.toContain(NOTIFICATION_TYPE_META.attendance_recorded.label);
    unmount();
  });

  it('defaults every control to On when there are no override rows', async () => {
    const { container, unmount } = await render(
      <NotificationTypePreferences emailEnabled overrides={{}} />,
    );

    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.length).toBe(CONFIGURABLE_NOTIFICATION_TYPES.length * 2);
    expect(buttons.every((b) => b.textContent?.trim() === 'On')).toBe(true);
    unmount();
  });

  it('reflects an explicit false', async () => {
    const { container, unmount } = await render(
      <NotificationTypePreferences
        emailEnabled
        overrides={{ 'match_published:push': false }}
      />,
    );

    const off = [...container.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === 'Off',
    );
    expect(off).toHaveLength(1);
    expect(off[0]?.getAttribute('aria-pressed')).toBe('false');
    unmount();
  });

  it('submits the opposite of the current value', async () => {
    const { container, unmount } = await render(
      <NotificationTypePreferences emailEnabled overrides={{}} />,
    );

    // Everything is On, so every hidden `enabled` field must say false.
    const values = [...container.querySelectorAll('input[name="enabled"]')].map((i) =>
      i.getAttribute('value'),
    );
    expect(new Set(values)).toEqual(new Set(['false']));
    unmount();
  });

  it('names the type and channel on every submission', async () => {
    const { container, unmount } = await render(
      <NotificationTypePreferences emailEnabled overrides={{}} />,
    );

    const types = [...container.querySelectorAll('input[name="notification_type"]')];
    const channels = [...container.querySelectorAll('input[name="channel"]')];
    expect(types).toHaveLength(CONFIGURABLE_NOTIFICATION_TYPES.length * 2);
    expect(new Set(channels.map((c) => c.getAttribute('value')))).toEqual(
      new Set(['push', 'email']),
    );
    unmount();
  });

  it('disables the email column when the global master is off, without changing values', async () => {
    const { container, unmount } = await render(
      <NotificationTypePreferences
        emailEnabled={false}
        overrides={{ 'match_published:email': false }}
      />,
    );

    const disabled = [...container.querySelectorAll('button[disabled]')];
    // Exactly the email column.
    expect(disabled).toHaveLength(CONFIGURABLE_NOTIFICATION_TYPES.length);

    // The stored value is still shown, not erased or forced.
    const emailInputs = [...container.querySelectorAll('input[name="enabled"]')];
    expect(emailInputs.some((i) => i.getAttribute('value') === 'true')).toBe(true);
    unmount();
  });

  it('says the in-app inbox is unaffected', async () => {
    const { container, unmount } = await render(
      <NotificationTypePreferences emailEnabled overrides={{}} />,
    );

    expect(container.textContent).toContain('in-app inbox');
    unmount();
  });

  it('gives every control an accessible label naming the type and channel', async () => {
    const { container, unmount } = await render(
      <NotificationTypePreferences emailEnabled overrides={{}} />,
    );

    for (const button of container.querySelectorAll('button')) {
      const label = button.getAttribute('aria-label') ?? '';
      expect(label.length).toBeGreaterThan(0);
      expect(label).toMatch(/push|email/);
      expect(label).toMatch(/currently (on|off)/);
      expect(button.getAttribute('aria-pressed')).toMatch(/^(true|false)$/);
    }
    unmount();
  });

  it('has a header row identifying the two channels', async () => {
    const { container, unmount } = await render(
      <NotificationTypePreferences emailEnabled overrides={{}} />,
    );

    const headers = [...container.querySelectorAll('th[scope="col"]')].map((h) =>
      h.textContent?.trim(),
    );
    expect(headers).toEqual(['Notification', 'Push', 'Email']);
    unmount();
  });

  it('exposes no raw enum name to a reader', async () => {
    const { container, unmount } = await render(
      <NotificationTypePreferences emailEnabled overrides={{}} />,
    );

    // The enum values live in hidden inputs, which is legitimate. What must
    // never appear in prose is the enum FORM — snake_case. Matching a bare
    // single-word value like `reminder` would false-positive on the perfectly
    // good label "Match reminder", so the signature is the underscore.
    const visible = container.textContent ?? '';
    for (const type of CONFIGURABLE_NOTIFICATION_TYPES.filter((t) => t.includes('_'))) {
      expect(visible, type).not.toContain(type);
    }
    expect(visible).not.toMatch(/[a-z]+_[a-z]+/);
    unmount();
  });
});

'use client';

import { useActionState } from 'react';
import {
  CONFIGURABLE_NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_META,
} from '@/lib/notifications/notification-types';
import { setNotificationTypePreferenceAction } from '@/server/actions/notification-preferences';
import type { NotificationChannel, NotificationType } from '@/types/database';

/**
 * The per-type matrix: which notifications leave the building, and how.
 *
 * ── ABSENCE MEANS ON ───────────────────────────────────────────────────────
 *
 * A member with no rows sees everything switched on, because that is what the
 * delivery worker will do. The page never writes a row just by being looked at.
 *
 * ── EMAIL COLUMN FOLLOWS THE MASTER SWITCH ─────────────────────────────────
 *
 * With the global email toggle off, the email controls are disabled — sending
 * is genuinely impossible, and an active-looking switch that changes nothing is
 * a lie. Their stored values are untouched, so turning the master back on
 * restores exactly the choices somebody made.
 */

function Toggle({
  type,
  channel,
  enabled,
  disabled,
  label,
}: {
  type: NotificationType;
  channel: NotificationChannel;
  enabled: boolean;
  disabled: boolean;
  label: string;
}) {
  const [state, submit, pending] = useActionState(setNotificationTypePreferenceAction, null);

  // The server's value, full stop. The action revalidates the page on success,
  // so `enabled` is refreshed by the framework rather than guessed here — an
  // optimistic flip that lies when the write fails is worse than a slower one
  // that tells the truth.
  const next = !enabled;

  return (
    <form action={submit} className="contents">
      <input type="hidden" name="notification_type" value={type} />
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="enabled" value={String(next)} />
      <button
        type="submit"
        disabled={disabled || pending}
        aria-label={`${label} — ${channel === 'push' ? 'push' : 'email'}: currently ${
          enabled ? 'on' : 'off'
        }. Activate to turn ${next ? 'on' : 'off'}.`}
        aria-pressed={enabled}
        className="rounded-md border border-line px-3 py-1 text-sm disabled:opacity-50"
      >
        {pending ? '…' : enabled ? 'On' : 'Off'}
      </button>
      {state?.ok === false && (
        <span role="alert" className="sr-only">
          {state.message}
        </span>
      )}
    </form>
  );
}

export function NotificationTypePreferences({
  emailEnabled,
  overrides,
}: {
  emailEnabled: boolean;
  /** `"<type>:<channel>"` → enabled. Anything absent is on. */
  overrides: Record<string, boolean>;
}) {
  return (
    <div className="mt-8">
      <h2 className="text-base font-semibold">What gets sent to you</h2>
      <p className="mt-1 text-sm text-muted">
        These control push and email only. Every notification still appears in your in-app inbox
        whatever you choose here.
      </p>

      {!emailEnabled && (
        <p className="mt-3 text-sm text-muted">
          Email notifications are off, so the email column is unavailable. Your choices are kept —
          turn email back on above and they will apply again.
        </p>
      )}

      <table className="mt-4 w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-line text-sm text-muted">
            <th scope="col" className="py-2 pr-4 font-medium">
              Notification
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Push
            </th>
            <th scope="col" className="py-2 font-medium">
              Email
            </th>
          </tr>
        </thead>
        <tbody>
          {CONFIGURABLE_NOTIFICATION_TYPES.map((type) => {
            const meta = NOTIFICATION_TYPE_META[type];
            return (
              <tr key={type} className="border-b border-line/60 align-top">
                <th scope="row" className="py-3 pr-4 font-normal">
                  <span className="text-sm">{meta.label}</span>
                  {meta.description !== undefined && (
                    <span className="mt-0.5 block text-xs text-muted">{meta.description}</span>
                  )}
                </th>
                <td className="py-3 pr-4">
                  <Toggle
                    type={type}
                    channel="push"
                    enabled={overrides[`${type}:push`] ?? true}
                    disabled={false}
                    label={meta.label}
                  />
                </td>
                <td className="py-3">
                  <Toggle
                    type={type}
                    channel="email"
                    enabled={overrides[`${type}:email`] ?? true}
                    disabled={!emailEnabled}
                    label={meta.label}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

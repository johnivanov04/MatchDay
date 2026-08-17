'use client';

import { useActionState, useCallback, useState } from 'react';
import {
  registerPushSubscriptionAction,
  removePushSubscriptionAction,
  setPushSubscriptionEnabledAction,
} from '@/server/actions/push';
import type { PushSubscriptionRow } from '@/types/database';

/**
 * Enabling phone notifications.
 *
 * The permission prompt is fired **only** from this button's click handler.
 * Asking on page load is the single most reliable way to get permanently
 * denied — browsers increasingly block prompts without a user gesture, and a
 * user who denies once cannot easily be asked again. So the request happens at
 * the moment somebody has said, in as many words, that they want alerts.
 *
 * Everything degrades. A browser without service workers or PushManager, a
 * user who denies, a device that later drops its subscription: all of them keep
 * receiving the canonical in-app notification, because push was only ever a
 * copy of it.
 */

type Status =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'unsupported' }
  | { kind: 'denied' }
  | { kind: 'error'; message: string }
  | { kind: 'enabled' };

/**
 * VAPID public keys are base64url; `PushManager` wants raw bytes.
 *
 * Backed by an explicit `ArrayBuffer` rather than the default allocation,
 * because `applicationServerKey` requires a `BufferSource` over a plain
 * `ArrayBuffer` — a `Uint8Array` that might sit on a `SharedArrayBuffer` does
 * not satisfy it.
 */
function base64UrlToBytes(base64Url: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) {
    view[i] = raw.charCodeAt(i);
  }
  return buffer;
}

/** A best-effort, non-identifying label so a user can tell their devices apart. */
function describeDevice(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS device';
  if (/Android/.test(ua)) return 'Android device';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'This device';
}

export function EnablePushButton({ vapidPublicKey }: { vapidPublicKey: string | null }) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const enable = useCallback(async () => {
    if (vapidPublicKey === null) {
      setStatus({
        kind: 'error',
        message: 'Phone notifications are not configured on this deployment.',
      });
      return;
    }

    if (
      typeof navigator === 'undefined' ||
      !('serviceWorker' in navigator) ||
      typeof window === 'undefined' ||
      !('PushManager' in window) ||
      !('Notification' in window)
    ) {
      setStatus({ kind: 'unsupported' });
      return;
    }

    setStatus({ kind: 'working' });

    try {
      // The prompt, fired from this click and nowhere else.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setStatus({ kind: 'denied' });
        return;
      }

      const registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
        updateViaCache: 'none',
      });
      await navigator.serviceWorker.ready;

      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          // Required by every browser: a push may only be used to show the user
          // something, never to run silent background work.
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(vapidPublicKey),
        }));

      const json = subscription.toJSON();
      const formData = new FormData();
      formData.set('endpoint', json.endpoint ?? '');
      formData.set('p256dh', json.keys?.['p256dh'] ?? '');
      formData.set('auth', json.keys?.['auth'] ?? '');
      formData.set('device_label', describeDevice());

      const result = await registerPushSubscriptionAction(null, formData);
      if (!result.ok) {
        setStatus({ kind: 'error', message: result.message });
        return;
      }

      setStatus({ kind: 'enabled' });
      window.location.reload();
    } catch {
      setStatus({
        kind: 'error',
        message: 'This device could not be registered for notifications.',
      });
    }
  }, [vapidPublicKey]);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => void enable()}
        disabled={status.kind === 'working'}
        className="inline-flex min-h-control items-center justify-center rounded-lg bg-pitch-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-pitch-700 disabled:opacity-55"
      >
        {status.kind === 'working' ? 'Enabling…' : 'Enable phone notifications'}
      </button>

      {status.kind === 'unsupported' ? (
        <p role="status" className="text-sm text-muted">
          This browser does not support phone notifications. You will still receive everything in
          the app.
        </p>
      ) : null}

      {status.kind === 'denied' ? (
        <p role="status" className="text-sm text-muted">
          Notifications are blocked for this site in your browser settings. Everything still
          arrives in your MatchDay inbox.
        </p>
      ) : null}

      {status.kind === 'error' ? (
        <p role="alert" className="text-sm text-whistle-600 dark:text-whistle-300">
          {status.message}
        </p>
      ) : null}

      <p className="text-xs text-muted">
        On iPhone, add MatchDay to your home screen first — iOS only delivers web notifications to
        installed apps.
      </p>
    </div>
  );
}

export function DeviceRow({ device }: { device: PushSubscriptionRow }) {
  const [toggleState, toggle, toggling] = useActionState(setPushSubscriptionEnabledAction, null);
  const [removeState, remove, removing] = useActionState(removePushSubscriptionAction, null);

  return (
    <li className="surface-card flex items-start justify-between gap-3 p-3">
      <div>
        <p className="text-sm font-semibold">{device.device_label ?? 'Unnamed device'}</p>
        <p className="text-xs text-muted">
          {device.enabled ? 'Receiving alerts' : `Off${device.disabled_reason === null ? '' : ` — ${device.disabled_reason.replaceAll('_', ' ')}`}`}
          {device.last_success_at === null
            ? ''
            : ` · last delivered ${new Date(device.last_success_at).toLocaleDateString('en-GB')}`}
        </p>
      </div>

      <div className="flex shrink-0 gap-2">
        <form action={toggle}>
          <input type="hidden" name="subscription_id" value={device.id} />
          <input type="hidden" name="enabled" value={device.enabled ? 'false' : 'true'} />
          <button
            type="submit"
            disabled={toggling}
            className="min-h-control rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-3 py-1.5 text-sm disabled:opacity-55"
          >
            {device.enabled ? 'Turn off' : 'Turn on'}
          </button>
        </form>

        <form action={remove}>
          <input type="hidden" name="subscription_id" value={device.id} />
          <button
            type="submit"
            disabled={removing}
            className="min-h-control rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-3 py-1.5 text-sm disabled:opacity-55"
          >
            Remove
          </button>
        </form>
      </div>

      {toggleState?.ok === false || removeState?.ok === false ? (
        <p role="alert" className="text-sm text-whistle-600 dark:text-whistle-300">
          That device could not be updated.
        </p>
      ) : null}
    </li>
  );
}

/**
 * Turning on notifications inside the native iOS app.
 *
 * ── NOTHING HERE RUNS ON THE WEB ───────────────────────────────────────────
 *
 * Every Capacitor import is dynamic and behind a native check, for the same
 * reason as in `native-shell.tsx`: a static import would put the push plugin
 * into the bundle of every browser visitor, to run code that immediately
 * decides it is not native.
 */

import type { PushNotificationsPlugin } from '@capacitor/push-notifications';
import { isNativeIOSClient } from '@/lib/platform/native';
import type { ApnsEnvironment } from '@/types/database';

/**
 * Where this installation's identity is kept.
 *
 * Local storage rather than a cookie or the session: it has to survive signing
 * out, because the whole point is to identify the *device* independently of who
 * is currently signed in on it. It is deliberately not cleared at sign-out —
 * sign-out removes the server-side row, and the next person to sign in on this
 * phone re-registers the same installation, which is what transfers ownership
 * rather than accumulating a second dead row.
 */
const INSTALLATION_ID_KEY = 'matchday.installation_id';

/**
 * This installation's id, created on first use.
 *
 * Shaped to satisfy `push_subscriptions_installation_id_shape`
 * (`^[A-Za-z0-9_-]{8,64}$`), which a UUID does.
 */
export function getInstallationId(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const existing = window.localStorage.getItem(INSTALLATION_ID_KEY);
    if (existing !== null && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) {
      return existing;
    }

    const created = createInstallationId();
    window.localStorage.setItem(INSTALLATION_ID_KEY, created);
    return created;
  } catch {
    // Local storage can be unavailable or full. Without an installation id
    // there is no stable device identity, so the caller must not register.
    return null;
  }
}

function createInstallationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // `randomUUID` needs a secure context. The app is always https, so this is
  // only reached in a browser old enough not to have it.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Which APNs environment this build talks to, from the local `ApsEnvironment`
 * plugin.
 *
 * The plugin reads a build setting surfaced through `Info.plist` —
 * `sandbox` for Debug, `production` for Release — rather than inspecting the
 * signed entitlement at runtime. See `ios/App/App/ApsEnvironmentPlugin.swift`
 * for why the two cleverer options were rejected.
 *
 * `null` when it cannot be read, and a `null` here means **do not register**.
 * A device stored against a guessed environment is a device that silently never
 * receives anything: the token is rejected by the wrong host as
 * `BadDeviceToken`, which is indistinguishable from a corrupt token, and the
 * row is then retired for a fault it never had.
 */
export async function readSignedApsEnvironment(): Promise<ApnsEnvironment | null> {
  try {
    const { registerPlugin } = await import('@capacitor/core');
    const ApsEnvironment = registerPlugin<{
      get(): Promise<{ environment?: string }>;
    }>('ApsEnvironment');

    const { environment } = await ApsEnvironment.get();

    // `sandbox` is Apple's name for the environment; `development` is what the
    // entitlement and the `apns_environment` column call it. Both spellings are
    // accepted and only the column's is ever sent on.
    if (environment === 'sandbox' || environment === 'development') {
      return 'development';
    }

    return environment === 'production' ? 'production' : null;
  } catch {
    return null;
  }
}

/** A label so somebody with several devices can tell them apart on the list. */
function describeNativeDevice(): string {
  return /iPad/.test(navigator.userAgent) ? 'iPad (MatchDay app)' : 'iPhone (MatchDay app)';
}

export type NativePushOutcome =
  | { kind: 'registered' }
  | { kind: 'unsupported' }
  | { kind: 'denied' }
  | { kind: 'error'; message: string };

/** How long to wait for APNs to hand back a token before giving up. */
const REGISTRATION_TIMEOUT_MS = 15_000;

/**
 * Asks for permission, registers with APNs, and stores the resulting token.
 *
 * ── CALLED FROM A TAP, NEVER FROM A MOUNT ──────────────────────────────────
 *
 * iOS grants exactly one chance to show the permission alert. A user who
 * dismisses one they did not ask for cannot be asked again from inside the app
 * — they have to find MatchDay in Settings — so the prompt is fired only after
 * somebody has said in as many words that they want alerts. Everything still
 * arrives in the in-app inbox either way, which is what makes it affordable to
 * wait for that.
 *
 * `register` is what performs the server-side write; it is injected so this
 * module stays free of server-action imports and remains unit-testable.
 */
export async function enableNativePushNotifications(register: {
  (input: {
    deviceToken: string;
    environment: ApnsEnvironment;
    installationId: string;
    deviceLabel: string;
  }): Promise<{ ok: boolean; message?: string }>;
}): Promise<NativePushOutcome> {
  if (!isNativeIOSClient()) {
    return { kind: 'unsupported' };
  }

  const installationId = getInstallationId();
  if (installationId === null) {
    return { kind: 'error', message: 'This device could not be identified.' };
  }

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    // `requestPermissions` resolves to the *current* state, prompting only when
    // it is still `prompt`. Somebody who denied earlier gets the honest answer
    // rather than a second alert iOS would never show.
    const permission = await PushNotifications.requestPermissions();
    if (permission.receive !== 'granted') {
      return { kind: 'denied' };
    }

    // Read before registering. If the entitlement cannot be read there is no
    // point holding a token we would not know where to send.
    const environment = await readSignedApsEnvironment();
    if (environment === null) {
      return {
        kind: 'error',
        message: 'This build is not set up for notifications. Please update the app.',
      };
    }

    const deviceToken = await acquireDeviceToken(PushNotifications);
    const result = await register({
      deviceToken,
      environment,
      installationId,
      deviceLabel: describeNativeDevice(),
    });

    return result.ok
      ? { kind: 'registered' }
      : { kind: 'error', message: result.message ?? 'This device could not be registered.' };
  } catch {
    return { kind: 'error', message: 'This device could not be registered for notifications.' };
  }
}

/**
 * The APNs handshake: attach the listeners, ask, wait for one answer.
 *
 * `PushNotifications` is passed in rather than imported again so that the two
 * callers each keep their single dynamic import. Only the *type* is imported
 * statically, which erases at compile time and puts nothing in the bundle.
 */
async function acquireDeviceToken(PushNotifications: PushNotificationsPlugin): Promise<string> {
  return new Promise<string>((resolve, reject) => {
      const handles: Array<{ remove: () => Promise<void> }> = [];
      let settled = false;

      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const handle of handles) void handle.remove();
        action();
      };

      const timer = setTimeout(
        () => finish(() => reject(new Error('APNs did not respond'))),
        REGISTRATION_TIMEOUT_MS,
      );

      void (async () => {
        // Both listeners are attached before `register()` is called: the token
        // can arrive on the very next turn of the loop, and a listener added
        // after that would never see it.
        handles.push(
          await PushNotifications.addListener('registration', ({ value }) =>
            finish(() => resolve(value)),
          ),
        );
        handles.push(
          await PushNotifications.addListener('registrationError', () =>
            finish(() => reject(new Error('APNs refused to register this device'))),
          ),
        );

        await PushNotifications.register();
      })().catch((error: unknown) => finish(() => reject(error)));
  });
}

/**
 * Re-registers a device that already has permission, silently.
 *
 * ── WHY THIS RUNS AT EVERY LAUNCH ──────────────────────────────────────────
 *
 * APNs reissues device tokens — on restore from a backup, on some OS upgrades,
 * and otherwise at its own discretion. Nothing notifies the server when it
 * happens: the old token simply stops resolving, and the only symptom is that
 * one player quietly stops getting alerts. Apple's own guidance is to call
 * `registerForRemoteNotifications` on every launch and pass on whatever comes
 * back, which is what this does.
 *
 * It cannot prompt. `register()` only asks iOS for a token, and iOS returns one
 * without any interface when authorisation already exists — which is why the
 * permission state is checked first and nothing happens at all unless it is
 * already `granted`.
 *
 * The re-registration lands on the same `installation_id`, so it updates the
 * existing row in place rather than adding a second one. That is the whole
 * reason the installation id exists.
 */
export async function refreshNativePushRegistration(register: {
  (input: {
    deviceToken: string;
    environment: ApnsEnvironment;
    installationId: string;
    deviceLabel: string;
  }): Promise<{ ok: boolean; message?: string }>;
}): Promise<void> {
  if (!isNativeIOSClient()) {
    return;
  }

  const installationId = getInstallationId();
  if (installationId === null) {
    return;
  }

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    // Checked, never requested. A player who has not opted in must not meet a
    // permission alert because they opened the app.
    const permission = await PushNotifications.checkPermissions();
    if (permission.receive !== 'granted') {
      return;
    }

    const environment = await readSignedApsEnvironment();
    if (environment === null) {
      return;
    }

    const deviceToken = await acquireDeviceToken(PushNotifications);
    await register({
      deviceToken,
      environment,
      installationId,
      deviceLabel: describeNativeDevice(),
    });
  } catch {
    // Best effort by construction. A refresh that fails leaves the previous
    // token in place, which is either still valid or about to be retired by
    // the dispatcher on its own evidence.
  }
}

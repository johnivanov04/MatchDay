import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from './helpers/render';

/**
 * Whether the devices page offers to turn notifications on.
 *
 * ── ONE QUESTION PER PLATFORM ──────────────────────────────────────────────
 *
 * Web Push needs a VAPID key pair. APNs needs Apple credentials. Neither says
 * anything about the other, and the page used to ask only the Web Push
 * question — so a deployment with APNs configured and no VAPID key told every
 * iOS app user that notifications "are not configured on this deployment",
 * with the working native control rendered one component further down and
 * therefore unreachable.
 *
 * That was found on a physical iPhone against a server holding sandbox APNs
 * credentials and no VAPID key at all. These four cases are the matrix.
 */

const requireOnboardedUser = vi.fn(async () => undefined);
const isNativeIOSApp = vi.fn(async () => false);
const readApnsConfiguration = vi.fn((): unknown => null);

vi.mock('@/lib/auth/page-guards', () => ({
  requireOnboardedUser: () => requireOnboardedUser(),
}));
vi.mock('@/lib/platform/native-server', () => ({
  isNativeIOSApp: () => isNativeIOSApp(),
}));
vi.mock('@/lib/push/apns', () => ({
  readApnsConfiguration: () => readApnsConfiguration(),
}));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    from: () => ({ select: () => ({ order: async () => ({ data: [] }) }) }),
  }),
}));
// The client component's own dependencies. Nothing here is exercised: these
// tests are about which branch the *page* renders.
vi.mock('@/server/actions/push', () => ({
  registerApnsDeviceAction: vi.fn(),
  registerPushSubscriptionAction: vi.fn(),
  removePushSubscriptionAction: vi.fn(),
  setPushSubscriptionEnabledAction: vi.fn(),
}));
vi.mock('@/lib/platform/apns-client', () => ({ enableNativePushNotifications: vi.fn() }));

const { default: DevicesPage } = await import('@/app/(app)/settings/devices/page');

const APNS_CONFIGURED = {
  teamId: 'VYC3499K46',
  bundleId: 'com.johnivanov.matchday',
  keys: { development: { keyId: 'SANDBOX123', privateKey: 'x' }, production: null },
};

const savedEnvironment = { ...process.env };

async function renderPage() {
  return render(await DevicesPage());
}

/** The control the player taps to turn notifications on. */
function enableButton(container: HTMLElement): HTMLElement | null {
  return (
    [...container.querySelectorAll('button')].find((b) =>
      /enable phone notifications/i.test(b.textContent ?? ''),
    ) ?? null
  );
}

function saysUnavailable(container: HTMLElement): boolean {
  return /not configured on this deployment/i.test(container.textContent ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  isNativeIOSApp.mockResolvedValue(false);
  readApnsConfiguration.mockReturnValue(null);
  delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
});

afterEach(() => {
  process.env = { ...savedEnvironment };
});

describe('the native iOS app', () => {
  beforeEach(() => {
    isNativeIOSApp.mockResolvedValue(true);
  });

  it('offers to enable notifications when APNs is configured and no VAPID key exists', async () => {
    // The exact production-blocking case: APNs credentials present, VAPID
    // absent. Before the fix this rendered "not configured".
    readApnsConfiguration.mockReturnValue(APNS_CONFIGURED);

    const { container, unmount } = await renderPage();
    expect(enableButton(container)).not.toBeNull();
    expect(saysUnavailable(container)).toBe(false);
    unmount();
  });

  it('reports unavailable when APNs is absent, whatever the VAPID key says', async () => {
    // A VAPID key cannot help a WKWebView: `PushManager` does not exist there.
    // Offering the button would produce a control that can only fail at
    // registration.
    readApnsConfiguration.mockReturnValue(null);
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'BPublicKeyValueForWebPush';

    const { container, unmount } = await renderPage();
    expect(enableButton(container)).toBeNull();
    expect(saysUnavailable(container)).toBe(true);
    unmount();
  });

  it('renders without a VAPID key at all, which the native path never reads', async () => {
    readApnsConfiguration.mockReturnValue(APNS_CONFIGURED);
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

    const { container, unmount } = await renderPage();
    // Reaching here at all is the assertion: a null key must not throw on the
    // way through `EnablePushButton`.
    expect(enableButton(container)).not.toBeNull();
    // And the web-only guidance must not appear inside the app.
    expect(container.textContent).not.toMatch(/add matchday to your home screen/i);
    unmount();
  });
});

describe('the web', () => {
  beforeEach(() => {
    isNativeIOSApp.mockResolvedValue(false);
  });

  it('offers Web Push when a VAPID key is configured', async () => {
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'BPublicKeyValueForWebPush';

    const { container, unmount } = await renderPage();
    expect(enableButton(container)).not.toBeNull();
    expect(saysUnavailable(container)).toBe(false);
    unmount();
  });

  it('reports unavailable without a VAPID key, whatever APNs says', async () => {
    // APNs credentials do nothing for a browser.
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    readApnsConfiguration.mockReturnValue(APNS_CONFIGURED);

    const { container, unmount } = await renderPage();
    expect(enableButton(container)).toBeNull();
    expect(saysUnavailable(container)).toBe(true);
    unmount();
  });

  it('never consults the APNs credentials', async () => {
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'BPublicKeyValueForWebPush';

    const { unmount } = await renderPage();
    expect(readApnsConfiguration).not.toHaveBeenCalled();
    unmount();
  });
});

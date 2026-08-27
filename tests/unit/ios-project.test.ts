import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The iOS project's facts, asserted from the files that state them.
 *
 * None of this can be checked by the app at runtime — a build setting is a
 * build-time fact and the signed entitlement is not readable without either a
 * private API or a parser for undocumented code-signature layout, both of which
 * were rejected. What is left is to pin the project configuration itself, so a
 * change that would silently break notifications, Universal Links or an upload
 * fails here instead of in App Review.
 */

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

const PROJECT = read('ios/App/App.xcodeproj/project.pbxproj');
const INFO_PLIST = read('ios/App/App/Info.plist');
const ENTITLEMENTS = read('ios/App/App/App.entitlements');
const APP_DELEGATE = read('ios/App/App/AppDelegate.swift');

/**
 * The App target's two build-configuration blocks, sliced out by the setting
 * only they carry. The project-level configurations do not sign anything.
 */
function appTargetConfiguration(name: 'Debug' | 'Release'): string {
  const blocks = [
    ...PROJECT.matchAll(
      /\t{4}CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;[\s\S]*?\t{3}name = (Debug|Release);/g,
    ),
  ];

  expect(blocks).toHaveLength(2);
  const block = blocks.find((match) => match[1] === name);
  expect(block, name).toBeDefined();
  return block?.[0] ?? '';
}

describe('the APNs environment comes from the build configuration', () => {
  /**
   * Debug is signed with a development profile and gets
   * `aps-environment: development`; a Release archive exported for TestFlight
   * or the App Store is rewritten to `production`. `MATCHDAY_APNS_ENVIRONMENT`
   * has to agree with that, because it is what the app reports to the server
   * and what selects the APNs host a token is sent to.
   */
  it.each([
    ['Debug', 'sandbox'],
    ['Release', 'production'],
  ] as const)('%s resolves to %s', (configuration, expected) => {
    expect(appTargetConfiguration(configuration)).toContain(
      `MATCHDAY_APNS_ENVIRONMENT = ${expected};`,
    );
  });

  it('reaches the bundle through Info.plist', () => {
    // Set in the project but never surfaced, the plugin would read nothing and
    // no device would ever register.
    expect(INFO_PLIST).toContain('<key>MATCHDAY_APNS_ENVIRONMENT</key>');
    expect(INFO_PLIST).toContain('<string>$(MATCHDAY_APNS_ENVIRONMENT)</string>');
  });

  it('stays paired with the entitlement Xcode will sign', () => {
    /**
     * ── THE INVARIANT, STATED IN ONE PLACE ─────────────────────────────────
     *
     * Two facts decide which APNs host a device's notifications go to, and they
     * are set by different mechanisms in different files:
     *
     *   App.entitlements  aps-environment            (what Xcode signs)
     *   project.pbxproj   MATCHDAY_APNS_ENVIRONMENT  (what the app reports)
     *
     * They must agree, configuration by configuration:
     *
     *   Debug   → development entitlement → `sandbox`    → api.sandbox.push.apple.com
     *   Release → distribution rewrites to `production`  → api.push.apple.com
     *
     * The entitlements file requests `development` and nothing else. That is
     * not a Debug-only value: Xcode rewrites it to `production` when the
     * archive is re-signed for App Store distribution, which was verified on a
     * real exported IPA — the archive carries `development`, the exported
     * artefact carries `production`. So the literal here is correct for both,
     * and must not be "corrected" to `production`.
     *
     * ── WHY THIS IS WORTH A TEST ───────────────────────────────────────────
     *
     * Breaking the pairing is silent and expensive. Setting Release to
     * `sandbox` would make every TestFlight device register a production token
     * under a development environment; the dispatcher would send it to the
     * sandbox host; APNs would answer `BadDeviceToken`; and
     * `classifyApnsFailure` would — correctly, given what it was told —
     * invalidate every one of those devices. Every tester would silently stop
     * receiving notifications and would have to re-enable them by hand.
     *
     * Nothing at runtime can catch that: the entitlement is a build-time fact
     * the app cannot read without a private API or a code-signature parser,
     * both of which were rejected. This assertion is the only guard.
     */
    expect(ENTITLEMENTS).toContain('<key>aps-environment</key>');
    expect(ENTITLEMENTS).toMatch(
      /<key>aps-environment<\/key>\s*<string>development<\/string>/,
    );

    // Neither configuration may drift from its half of the pairing.
    expect(appTargetConfiguration('Debug')).toContain('MATCHDAY_APNS_ENVIRONMENT = sandbox;');
    expect(appTargetConfiguration('Release')).toContain(
      'MATCHDAY_APNS_ENVIRONMENT = production;',
    );

    // And the two must never be the same value: identical settings would mean
    // one of the two configurations is addressing the wrong APNs host.
    const debugValue = /MATCHDAY_APNS_ENVIRONMENT = (\w+);/.exec(appTargetConfiguration('Debug'));
    const releaseValue = /MATCHDAY_APNS_ENVIRONMENT = (\w+);/.exec(
      appTargetConfiguration('Release'),
    );
    expect(debugValue?.[1]).not.toBe(releaseValue?.[1]);
  });

  it('is read by public bundle configuration, not by a code-signature parser', () => {
    /**
     * The two rejected approaches, asserted as absent.
     *
     * `SecTaskCopyValueForEntitlement` links on iOS but is declared only in the
     * macOS SDK, so calling it means forward-declaring a private symbol.
     * Parsing `LC_CODE_SIGNATURE` avoids that and instead depends on
     * undocumented code-signing layout in a binary Apple re-signs on the way to
     * the App Store.
     */
    const plugin = read('ios/App/App/ApsEnvironmentPlugin.swift');

    for (const forbidden of [
      'SecTaskCopyValueForEntitlement',
      'SecTaskCreateFromSelf',
      'LC_CODE_SIGNATURE',
      'embedded.mobileprovision',
      '0xfade7171',
      '0xfade0cc0',
      'feedfacf',
    ]) {
      // Comments explaining why each was rejected use different spellings, so a
      // hit here is real code rather than prose.
      expect(plugin).not.toContain(`${forbidden}(`);
      expect(plugin).not.toMatch(new RegExp(`=\\s*${forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
    }

    expect(plugin).toContain('Bundle.main.object(forInfoDictionaryKey:');
  });
});

describe('the entitlements the signed build depends on', () => {
  /**
   * Verified against real signed artefacts during Build #2: the development
   * device profile carries `aps-environment: development` and the App Store
   * export carries `production`, both with the applinks domain. Neither can be
   * re-checked without building, so what is pinned here is the request that
   * produces them.
   */
  it('asks for push', () => {
    expect(ENTITLEMENTS).toContain('<key>aps-environment</key>');
  });

  it('asks for the one Universal Links domain', () => {
    expect(ENTITLEMENTS).toContain('<key>com.apple.developer.associated-domains</key>');
    expect(ENTITLEMENTS).toContain('<string>applinks:app.matchdayapps.com</string>');
  });

  it('is wired into both build configurations', () => {
    // A file on disk that no configuration references is signed into nothing.
    for (const configuration of ['Debug', 'Release'] as const) {
      expect(appTargetConfiguration(configuration)).toContain(
        'CODE_SIGN_ENTITLEMENTS = App/App.entitlements;',
      );
    }
  });
});

describe('the APNs bridge the push plugin depends on', () => {
  /**
   * `@capacitor/push-notifications` never speaks to iOS directly. It observes
   * two NotificationCenter names that Capacitor only *declares* — nothing in
   * the framework posts them — so the application has to forward the
   * UIApplicationDelegate callbacks itself. Its README requires this, and
   * `npx cap sync` does not add it to an AppDelegate that predates the plugin.
   *
   * Shipped without them, registration hangs until the caller's timeout and
   * iOS reports no error, because iOS did not fail: the token was delivered to
   * a method that did not exist. It compiles, signs, uploads and passes every
   * other gate. It cost one physical-device session to find, which is what
   * this test exists to prevent happening twice.
   */
  it.each([
    ['didRegisterForRemoteNotificationsWithDeviceToken', 'capacitorDidRegisterForRemoteNotifications'],
    ['didFailToRegisterForRemoteNotificationsWithError', 'capacitorDidFailToRegisterForRemoteNotifications'],
  ])('AppDelegate forwards %s', (callback, notificationName) => {
    expect(APP_DELEGATE).toContain(callback);
    expect(APP_DELEGATE).toContain(notificationName);
  });

  it('posts them, rather than merely mentioning them', () => {
    // A comment naming the notification would satisfy a substring check on its
    // own; the plugin needs the post.
    const posts = [...APP_DELEGATE.matchAll(/NotificationCenter\.default\.post\(\s*name:\s*\.(capacitor\w+)/g)]
      .map((match) => match[1])
      .sort();

    expect(posts).toEqual([
      'capacitorDidFailToRegisterForRemoteNotifications',
      'capacitorDidRegisterForRemoteNotifications',
    ]);
  });

  it('keeps them on the AppDelegate, which is where iOS calls them', () => {
    // There is no scene-based equivalent for remote-notification registration.
    const sceneDelegate = read('ios/App/App/SceneDelegate.swift');
    expect(sceneDelegate).not.toContain('didRegisterForRemoteNotificationsWithDeviceToken');
  });
});

describe('what an upload depends on', () => {
  it('embeds the privacy manifest as a resource', () => {
    // It existed for Build #1 and was in no build phase, so it never reached
    // the bundle and Apple never saw it. Absent from the target is
    // indistinguishable from absent altogether, and the build still succeeds.
    expect(PROJECT).toContain('PrivacyInfo.xcprivacy in Resources */,');
  });

  it('answers the export-compliance question up front', () => {
    expect(INFO_PLIST).toContain('<key>ITSAppUsesNonExemptEncryption</key>');
  });

  it('is build 2', () => {
    // Build #1 is already on TestFlight; App Store Connect rejects a re-upload
    // of the same build number outright.
    expect([...PROJECT.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => m[1])).toEqual([
      '2',
      '2',
    ]);
  });
});

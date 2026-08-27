import Capacitor
import Foundation

/**
 Which APNs environment this build talks to.

 ── WHY THE APP HAS TO SAY ────────────────────────────────────────────────────

 A device token minted in one APNs environment is meaningless in the other, and
 the rejection — `BadDeviceToken` — is indistinguishable from a corrupt token.
 So the server stores the environment on each device row rather than guessing,
 and this is where the value comes from. It cannot be recovered from the token,
 whose bytes are opaque and identically shaped in both.

 ── WHY THIS IS A BUILD SETTING AND NOT SOMETHING CLEVERER ────────────────────

 Two cleverer answers exist and both were rejected.

 `SecTaskCopyValueForEntitlement` reads the signed entitlement directly, and its
 symbol is exported by `Security.framework` on iOS — but `SecTask.h` ships only
 in the macOS SDK, so calling it means forward-declaring an undeclared symbol.
 That is private-API use, and it is the kind App Review's static analysis looks
 for.

 Parsing the `LC_CODE_SIGNATURE` blob out of our own Mach-O to read the same
 entitlement avoids the private symbol, and trades it for a dependency on
 undocumented code-signing layout in the binary Apple re-signs on the way to the
 App Store. Working today against a locally signed build is not evidence it
 works against that one.

 What is left is boring and durable: the build configuration already knows. A
 Debug build is signed with a development profile and gets
 `aps-environment: development`; a Release archive exported for TestFlight or
 the App Store is rewritten to `production`. `MATCHDAY_APNS_ENVIRONMENT` is set
 per configuration in the project and reaches the bundle through `Info.plist`,
 which is ordinary public configuration with no runtime parsing at all.

 ── THE ONE CONFIGURATION THIS GETS WRONG ─────────────────────────────────────

 Running the *Release* configuration directly from Xcode against a development
 provisioning profile: the entitlement would say `development` while this says
 `production`. That is not a supported way to test APNs, and it is documented as
 such in `docs/operations/production.md` §6 — development verification uses
 Debug.
 */
@objc(ApsEnvironmentPlugin)
public class ApsEnvironmentPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ApsEnvironmentPlugin"
    public let jsName = "ApsEnvironment"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise)
    ]

    /// Set per build configuration in project.pbxproj, surfaced via Info.plist.
    private static let infoDictionaryKey = "MATCHDAY_APNS_ENVIRONMENT"

    @objc func get(_ call: CAPPluginCall) {
        // Resolved rather than rejected when absent. The caller treats a missing
        // environment as "do not register", which is the safe outcome: a device
        // registered against a guess is a device that silently never receives
        // anything.
        if let environment = Self.configuredEnvironment() {
            call.resolve(["environment": environment])
        } else {
            call.resolve([:])
        }
    }

    /// `sandbox`, `production`, or `nil` when the build setting is missing.
    static func configuredEnvironment() -> String? {
        guard
            let raw = Bundle.main.object(forInfoDictionaryKey: infoDictionaryKey) as? String
        else {
            return nil
        }

        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        // Only the values the project sets are passed on. An unsubstituted
        // `$(MATCHDAY_APNS_ENVIRONMENT)` — what a stale Info.plist would yield —
        // falls through to nil rather than reaching the server.
        return ["sandbox", "development", "production"].contains(value) ? value : nil
    }
}

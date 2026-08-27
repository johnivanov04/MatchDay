import Capacitor
import UIKit

/**
 The web view host, with MatchDay's one local plugin attached.

 Plugins that arrive as npm packages are registered from the
 `packageClassList` that `npx cap sync` writes into `capacitor.config.json`.
 A plugin defined inside this target is not in that list and would never be
 registered, so it is attached here — `capacitorDidLoad()` is the documented
 point at which the bridge exists and the web view has not yet loaded.
 */
class MatchDayBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ApsEnvironmentPlugin())
    }
}

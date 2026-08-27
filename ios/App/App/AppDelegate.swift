import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    // ── APNs, and why these two live here ────────────────────────────────
    //
    // `@capacitor/push-notifications` never speaks to iOS directly. It observes
    // two NotificationCenter names, and Capacitor only *declares* them — see
    // CAPNotifications.swift. Nothing in the framework posts them, so unless
    // the application forwards these callbacks the plugin waits for a token
    // that iOS already delivered and threw away.
    //
    // That failure is silent in every way that matters: it compiles, signs,
    // uploads and passes every automated gate. On a device it presents as
    // registration hanging until the caller's timeout, with no error from iOS,
    // because iOS did not fail — nobody was listening. The plugin's README
    // requires these; `npx cap sync` does not add them to an AppDelegate that
    // predates the plugin, which is exactly how this one came to be missing.
    //
    // They stay on the AppDelegate rather than moving to the SceneDelegate:
    // remote-notification registration is a UIApplicationDelegate concern and
    // has no scene-based equivalent.

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(
            name: .capacitorDidRegisterForRemoteNotifications,
            object: deviceToken
        )
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Forwarded rather than swallowed. Without this the caller cannot tell
        // "APNs refused" from "APNs is slow", and both would look like a
        // timeout — which is precisely what made the missing pair hard to see.
        NotificationCenter.default.post(
            name: .capacitorDidFailToRegisterForRemoteNotifications,
            object: error
        )
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let configFileURL = ConfigStore.defaultConfigFileURL()
    private let queueFileURL = ConfigStore.defaultConfigFileURL()
        .deletingLastPathComponent()
        .appendingPathComponent("queue.json")

    private var config: TrackerConfig = .empty
    private var statusBarController: StatusBarController!
    private var activityQueue: ActivityQueue!
    private let apiClient: EventsAPIClient = URLSessionEventsAPIClient()

    private var idleMonitor: IdleMonitor?
    private var flushTimer: Timer?
    private var pendingCountForDisplay = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory) // menu-bar only, no Dock icon
        NSApp.mainMenu = Self.buildMainMenu()

        config = ConfigStore.load(from: configFileURL)
        activityQueue = ActivityQueue(storageURL: queueFileURL)

        statusBarController = StatusBarController(initialConfig: config)
        statusBarController.onSettingsSaved = { [weak self] newConfig in
            self?.applyConfig(newConfig)
        }

        applyConfig(config)
    }

    /// Persistence of queued activity timestamps is debounced (see
    /// `ActivityQueue`) to avoid rewriting the whole queue file on every
    /// activity tick. On a graceful quit there's no reason to accept even
    /// that small window of data loss, so force a final write here.
    func applicationWillTerminate(_ notification: Notification) {
        activityQueue?.persistNow()
    }

    private func applyConfig(_ newConfig: TrackerConfig) {
        config = newConfig
        try? ConfigStore.save(config, to: configFileURL)

        idleMonitor?.stop()
        flushTimer?.invalidate()

        guard config.isConfigured else {
            statusBarController.update(
                isActive: false, pendingCount: activityQueue.pendingCount, lastSuccessfulSyncAt: activityQueue.lastSuccessfulSyncAt
            )
            return
        }

        let pollInterval = TimeInterval(config.pollIntervalSeconds)

        idleMonitor = IdleMonitor(
            idleTimeSource: CGEventIdleTimeSource(),
            pollInterval: pollInterval
        ) { [weak self] in
            self?.recordActivity()
        }
        idleMonitor?.start()

        // Flush at least as often as we poll, but never more than every
        // minFlushIntervalSeconds, so the dashboard's live view (polled at
        // the same cadence) sees fresh data.
        let flushInterval = max(pollInterval, TrackerConstants.minFlushIntervalSeconds)
        let timer = Timer(timeInterval: flushInterval, repeats: true) { [weak self] _ in
            self?.flushQueue()
        }
        RunLoop.main.add(timer, forMode: .common)
        flushTimer = timer

        statusBarController.update(
            isActive: false, pendingCount: activityQueue.pendingCount, lastSuccessfulSyncAt: activityQueue.lastSuccessfulSyncAt
        )
    }

    /// A minimal application menu with a standard Edit submenu. Without one,
    /// Cmd+C/Cmd+V/Cmd+X/Cmd+A don't work anywhere in the app: those
    /// shortcuts are dispatched by AppKit matching them against a menu
    /// item's key equivalent (which then forwards the action, e.g. `paste:`,
    /// up the responder chain) — with no main menu at all, that dispatch
    /// never happens, even though the focused text view implements `paste:`
    /// itself. This bit the settings window's text fields directly.
    private static func buildMainMenu() -> NSMenu {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu
        appMenu.addItem(withTitle: "Quit WorkTracker", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenuItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        return mainMenu
    }

    private func recordActivity() {
        activityQueue.enqueue(Date())
        statusBarController.update(
            isActive: true, pendingCount: activityQueue.pendingCount, lastSuccessfulSyncAt: activityQueue.lastSuccessfulSyncAt
        )
    }

    private func flushQueue() {
        let queue = activityQueue!
        let client = apiClient
        let serverBaseURL = config.serverBaseURL
        let apiKey = config.apiKey

        Task {
            await queue.flush(client: client, serverBaseURL: serverBaseURL, apiKey: apiKey)
            await MainActor.run {
                self.statusBarController.update(
                    isActive: false, pendingCount: queue.pendingCount, lastSuccessfulSyncAt: queue.lastSuccessfulSyncAt
                )
            }
        }
    }
}

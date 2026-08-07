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

        config = ConfigStore.load(from: configFileURL)
        activityQueue = ActivityQueue(storageURL: queueFileURL)

        statusBarController = StatusBarController(initialConfig: config)
        statusBarController.onSettingsSaved = { [weak self] newConfig in
            self?.applyConfig(newConfig)
        }

        applyConfig(config)
    }

    private func applyConfig(_ newConfig: TrackerConfig) {
        config = newConfig
        try? ConfigStore.save(config, to: configFileURL)

        idleMonitor?.stop()
        flushTimer?.invalidate()

        guard config.isConfigured else {
            statusBarController.update(isActive: false, pendingCount: activityQueue.pendingCount)
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

        // Flush at least as often as we poll, but never more than every 15s,
        // so the dashboard's live view (polled every 15s) sees fresh data.
        let flushInterval = max(pollInterval, 15)
        let timer = Timer(timeInterval: flushInterval, repeats: true) { [weak self] _ in
            self?.flushQueue()
        }
        RunLoop.main.add(timer, forMode: .common)
        flushTimer = timer

        statusBarController.update(isActive: false, pendingCount: activityQueue.pendingCount)
    }

    private func recordActivity() {
        activityQueue.enqueue(Date())
        statusBarController.update(isActive: true, pendingCount: activityQueue.pendingCount)
    }

    private func flushQueue() {
        let queue = activityQueue!
        let client = apiClient
        let serverBaseURL = config.serverBaseURL
        let apiKey = config.apiKey

        Task {
            await queue.flush(client: client, serverBaseURL: serverBaseURL, apiKey: apiKey)
            await MainActor.run {
                self.statusBarController.update(isActive: false, pendingCount: queue.pendingCount)
            }
        }
    }
}

import AppKit

/// Owns the menu-bar icon and its dropdown: a live status line, a pending
/// (not-yet-synced) event count, the work/leisure tracking-mode choice, a
/// settings dialog, and Quit. All actual tracking logic lives in
/// `IdleMonitor` / `ActivityQueue` / `TrackingModeController`; this is just
/// the UI shell around them.
final class StatusBarController {
    private let statusItem: NSStatusItem
    private let statusMenuItem: NSMenuItem
    private let pendingMenuItem: NSMenuItem
    private let lastSyncMenuItem: NSMenuItem
    private let errorMenuItem: NSMenuItem
    private let trackingModeMenuItem: NSMenuItem
    private let trackingModeErrorMenuItem: NSMenuItem
    private var trackingModeItems: [WorkTypeSetting: NSMenuItem] = [:]
    var onSettingsSaved: ((TrackerConfig) -> Void)?
    var onWorkTypeSettingSelected: ((WorkTypeSetting) -> Void)?

    private var currentConfig: TrackerConfig
    private var settingsWindowController: SettingsWindowController?

    /// Sticky across `update()` calls that don't pass a fresh value (e.g.
    /// the settings-saved callback below, which has no queue reference of
    /// its own) — otherwise the line would flicker back to "Never" any time
    /// something else about the status changes.
    private var lastKnownSyncAt: Date?

    private static let lastSyncFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .medium
        return formatter
    }()

    init(initialConfig: TrackerConfig) {
        self.currentConfig = initialConfig
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        pendingMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        lastSyncMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        errorMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        errorMenuItem.isHidden = true
        trackingModeMenuItem = NSMenuItem(title: "Tracking mode", action: nil, keyEquivalent: "")
        trackingModeErrorMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        trackingModeErrorMenuItem.isHidden = true

        statusItem.button?.image = NSImage(
            systemSymbolName: "stopwatch", accessibilityDescription: "WorkTracker"
        )

        let menu = NSMenu()
        menu.addItem(statusMenuItem)
        menu.addItem(pendingMenuItem)
        menu.addItem(lastSyncMenuItem)
        menu.addItem(errorMenuItem)
        menu.addItem(.separator())

        let trackingModeMenu = NSMenu()
        for setting in WorkTypeSetting.allCases {
            let item = NSMenuItem(
                title: setting.menuTitle(serverMode: nil), action: #selector(selectWorkTypeSetting(_:)), keyEquivalent: ""
            )
            item.target = self
            item.representedObject = setting.rawValue
            trackingModeMenu.addItem(item)
            trackingModeItems[setting] = item
        }
        trackingModeMenu.addItem(.separator())
        let trackingModeHint = NSMenuItem(title: "Applies from now on", action: nil, keyEquivalent: "")
        trackingModeHint.isEnabled = false
        trackingModeMenu.addItem(trackingModeHint)
        // The disabled hint stays disabled; AppKit would enable it otherwise.
        trackingModeMenu.autoenablesItems = false
        trackingModeMenuItem.submenu = trackingModeMenu
        menu.addItem(trackingModeMenuItem)
        menu.addItem(trackingModeErrorMenuItem)
        menu.addItem(.separator())

        let settingsItem = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit WorkTracker", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

        statusItem.menu = menu

        update(isActive: false, pendingCount: 0)
        updateTrackingMode(initialConfig.workTypeSetting, serverMode: nil, serverIgnoresWorkType: false)
    }

    /// Checks the selected setting. `serverMode` (nil while unknown) is shown
    /// next to "As defined on server". `serverIgnoresWorkType` shows a
    /// warning that a pre-v1.30 server dropped the work type.
    func updateTrackingMode(_ setting: WorkTypeSetting, serverMode: TrackingMode?, serverIgnoresWorkType: Bool) {
        trackingModeMenuItem.title = "Tracking mode: \(setting.menuTitle(serverMode: serverMode))"
        for (itemSetting, item) in trackingModeItems {
            item.title = itemSetting.menuTitle(serverMode: serverMode)
            item.state = itemSetting == setting ? .on : .off
        }
        trackingModeErrorMenuItem.title = "⚠︎ Server ignores the tracking mode (update the server)"
        trackingModeErrorMenuItem.isHidden = !serverIgnoresWorkType
    }

    @objc private func selectWorkTypeSetting(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let setting = WorkTypeSetting(rawValue: raw) else { return }
        onWorkTypeSettingSelected?(setting)
    }

    func update(isActive: Bool, pendingCount: Int, lastSuccessfulSyncAt: Date? = nil, lastError: String? = nil) {
        if let lastSuccessfulSyncAt {
            lastKnownSyncAt = lastSuccessfulSyncAt
        }

        if !currentConfig.isConfigured {
            statusMenuItem.title = "Not configured — open Settings…"
        } else {
            statusMenuItem.title = isActive ? "Status: Active" : "Status: Idle"
        }
        pendingMenuItem.title = pendingCount == 0 ? "All events synced" : "\(pendingCount) event(s) queued"
        lastSyncMenuItem.title = lastKnownSyncAt.map { "Last synced: \(Self.lastSyncFormatter.string(from: $0))" }
            ?? "Last synced: never"
        errorMenuItem.title = lastError.map { "⚠︎ Sync problem: \($0)" } ?? ""
        errorMenuItem.isHidden = lastError == nil

        statusItem.button?.image = NSImage(
            systemSymbolName: isActive ? "stopwatch.fill" : "stopwatch",
            accessibilityDescription: "WorkTracker"
        )
    }

    @objc private func openSettings() {
        if settingsWindowController == nil {
            settingsWindowController = SettingsWindowController(config: currentConfig) { [weak self] updated in
                guard let self else { return }
                self.currentConfig = updated
                self.update(isActive: false, pendingCount: 0)
                self.onSettingsSaved?(updated)
            }
        } else {
            settingsWindowController?.reload(config: currentConfig)
        }
        settingsWindowController?.show()
    }
}

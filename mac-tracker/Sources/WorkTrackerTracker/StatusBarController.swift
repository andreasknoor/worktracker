import AppKit

/// Owns the menu-bar icon and its dropdown: a live status line, a pending
/// (not-yet-synced) event count, the work/leisure tracking-mode switch, a
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
    private var trackingModeItems: [TrackingMode: NSMenuItem] = [:]
    var onSettingsSaved: ((TrackerConfig) -> Void)?
    var onTrackingModeSelected: ((TrackingMode) -> Void)?

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
        for mode in TrackingMode.allCases {
            let item = NSMenuItem(title: mode.menuTitle, action: #selector(selectTrackingMode(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = mode.rawValue
            trackingModeMenu.addItem(item)
            trackingModeItems[mode] = item
        }
        trackingModeMenu.addItem(.separator())
        let trackingModeHint = NSMenuItem(title: "Applies from now on", action: nil, keyEquivalent: "")
        trackingModeHint.isEnabled = false
        trackingModeMenu.addItem(trackingModeHint)
        // Item enablement is driven by `updateTrackingMode`, not by AppKit.
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
        updateTrackingMode(nil, isSwitching: false, error: nil)
    }

    /// Checks the current mode (none while unknown) and disables switching
    /// while unconfigured or while a switch is in flight.
    func updateTrackingMode(_ mode: TrackingMode?, isSwitching: Bool, error: String?) {
        let label = mode.map { "Tracking mode: \($0.menuTitle)" } ?? "Tracking mode"
        trackingModeMenuItem.title = isSwitching ? "\(label) (switching…)" : label
        for (itemMode, item) in trackingModeItems {
            item.state = itemMode == mode ? .on : .off
            item.isEnabled = currentConfig.isConfigured && !isSwitching
        }
        trackingModeErrorMenuItem.title = error.map { "⚠︎ Couldn't switch mode: \($0)" } ?? ""
        trackingModeErrorMenuItem.isHidden = error == nil
    }

    @objc private func selectTrackingMode(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let mode = TrackingMode(rawValue: raw) else { return }
        onTrackingModeSelected?(mode)
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

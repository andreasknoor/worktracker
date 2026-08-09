import AppKit

/// Owns the menu-bar icon and its dropdown: a live status line, a pending
/// (not-yet-synced) event count, a settings dialog, and Quit. All actual
/// tracking logic lives in `IdleMonitor` / `ActivityQueue`; this is just the
/// UI shell around them.
final class StatusBarController {
    private let statusItem: NSStatusItem
    private let statusMenuItem: NSMenuItem
    private let pendingMenuItem: NSMenuItem
    private let lastSyncMenuItem: NSMenuItem
    var onSettingsSaved: ((TrackerConfig) -> Void)?

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

        statusItem.button?.image = NSImage(
            systemSymbolName: "stopwatch", accessibilityDescription: "WorkTracker"
        )

        let menu = NSMenu()
        menu.addItem(statusMenuItem)
        menu.addItem(pendingMenuItem)
        menu.addItem(lastSyncMenuItem)
        menu.addItem(.separator())

        let settingsItem = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit WorkTracker", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

        statusItem.menu = menu

        update(isActive: false, pendingCount: 0)
    }

    func update(isActive: Bool, pendingCount: Int, lastSuccessfulSyncAt: Date? = nil) {
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

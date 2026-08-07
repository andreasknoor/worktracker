import AppKit

/// Owns the menu-bar icon and its dropdown: a live status line, a pending
/// (not-yet-synced) event count, a settings dialog, and Quit. All actual
/// tracking logic lives in `IdleMonitor` / `ActivityQueue`; this is just the
/// UI shell around them.
final class StatusBarController {
    private let statusItem: NSStatusItem
    private let statusMenuItem: NSMenuItem
    private let pendingMenuItem: NSMenuItem
    var onSettingsSaved: ((TrackerConfig) -> Void)?

    private var currentConfig: TrackerConfig
    private var settingsWindowController: SettingsWindowController?

    init(initialConfig: TrackerConfig) {
        self.currentConfig = initialConfig
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        pendingMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")

        // A lone small SF Symbol dot is easy to miss (or mistake for another
        // app's icon) in a crowded menu bar. Pairing it with a short text
        // label makes the item unmistakable.
        statusItem.button?.image = NSImage(
            systemSymbolName: "circle.dashed", accessibilityDescription: "WorkTracker"
        )
        statusItem.button?.imagePosition = .imageLeading
        statusItem.button?.title = "WTK"

        let menu = NSMenu()
        menu.addItem(statusMenuItem)
        menu.addItem(pendingMenuItem)
        menu.addItem(.separator())

        let settingsItem = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit WorkTracker", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

        statusItem.menu = menu

        update(isActive: false, pendingCount: 0)
    }

    func update(isActive: Bool, pendingCount: Int) {
        if !currentConfig.isConfigured {
            statusMenuItem.title = "Not configured — open Settings…"
        } else {
            statusMenuItem.title = isActive ? "Status: Active" : "Status: Idle"
        }
        pendingMenuItem.title = pendingCount == 0 ? "All events synced" : "\(pendingCount) event(s) queued"

        statusItem.button?.image = NSImage(
            systemSymbolName: isActive ? "circle.fill" : "circle.dashed",
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

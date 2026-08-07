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
        let alert = NSAlert()
        alert.messageText = "WorkTracker Settings"
        alert.informativeText = "Server URL and API key come from the dashboard's Devices panel."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")

        let serverField = NSTextField(string: currentConfig.serverBaseURL)
        serverField.placeholderString = "https://your-project.vercel.app"

        let apiKeyField = NSTextField(string: currentConfig.apiKey)
        apiKeyField.placeholderString = "wtk_live_..."

        let pollField = NSTextField(string: String(currentConfig.pollIntervalSeconds))

        let stack = NSStackView(views: [
            labeled("Server URL", serverField),
            labeled("API Key", apiKeyField),
            labeled("Poll interval (seconds)", pollField),
        ])
        stack.orientation = .vertical
        stack.spacing = 10
        stack.alignment = .leading
        stack.frame = NSRect(x: 0, y: 0, width: 320, height: 130)

        alert.accessoryView = stack

        guard alert.runModal() == .alertFirstButtonReturn else { return }

        let pollInterval = Int(pollField.stringValue) ?? currentConfig.pollIntervalSeconds
        let updated = TrackerConfig(
            serverBaseURL: serverField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
            apiKey: apiKeyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
            pollIntervalSeconds: max(5, pollInterval)
        )
        currentConfig = updated
        update(isActive: false, pendingCount: 0)
        onSettingsSaved?(updated)
    }

    private func labeled(_ text: String, _ field: NSTextField) -> NSView {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 11)
        label.textColor = .secondaryLabelColor
        field.frame = NSRect(x: 0, y: 0, width: 300, height: 22)

        let column = NSStackView(views: [label, field])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 2
        return column
    }
}

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

    private static let fieldWidth: CGFloat = 460

    @objc private func openSettings() {
        let alert = NSAlert()
        alert.messageText = "WorkTracker Settings"
        alert.informativeText = "Server URL and API key come from the dashboard's Devices panel."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")

        // Generated API keys run ~70+ characters — a single-line NSTextField
        // only shows a fragment of that. Both fields use a wrapping,
        // scrollable text view instead, wide and tall enough to show the
        // whole value (or scroll to the rest) rather than truncating it.
        let (serverScroll, serverTextView) = Self.makeWrappingTextField(text: currentConfig.serverBaseURL, visibleHeight: 44)
        let (apiKeyScroll, apiKeyTextView) = Self.makeWrappingTextField(text: currentConfig.apiKey, visibleHeight: 60)

        let pollField = NSTextField(string: String(currentConfig.pollIntervalSeconds))
        pollField.frame = NSRect(x: 0, y: 0, width: 100, height: 24)

        let stack = NSStackView(views: [
            labeled("Server URL (e.g. https://your-project.vercel.app)", serverScroll),
            labeled("API Key", apiKeyScroll),
            labeled("Poll interval (seconds)", pollField),
        ])
        stack.orientation = .vertical
        stack.spacing = 14
        stack.alignment = .leading
        stack.frame = NSRect(x: 0, y: 0, width: Self.fieldWidth, height: 230)

        alert.accessoryView = stack
        alert.window.initialFirstResponder = serverTextView

        guard alert.runModal() == .alertFirstButtonReturn else { return }

        let pollInterval = Int(pollField.stringValue) ?? currentConfig.pollIntervalSeconds
        let updated = TrackerConfig(
            serverBaseURL: serverTextView.string.trimmingCharacters(in: .whitespacesAndNewlines),
            apiKey: apiKeyTextView.string.trimmingCharacters(in: .whitespacesAndNewlines),
            pollIntervalSeconds: max(5, pollInterval)
        )
        currentConfig = updated
        update(isActive: false, pendingCount: 0)
        onSettingsSaved?(updated)
    }

    /// A wide, wrapping, vertically-scrollable text field (plain text, no
    /// rich formatting) — used instead of a single-line NSTextField so long
    /// values like a full API key are actually visible, not truncated.
    private static func makeWrappingTextField(text: String, visibleHeight: CGFloat) -> (NSScrollView, NSTextView) {
        let textView = NSTextView(frame: NSRect(x: 0, y: 0, width: fieldWidth, height: visibleHeight))
        textView.string = text
        textView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        textView.isEditable = true
        textView.isSelectable = true
        textView.isRichText = false
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true

        // Word-wrap alone won't break a single unbroken token (like an API
        // key with no spaces) across lines — character wrapping ensures it
        // wraps within the visible width instead of running off it.
        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.lineBreakMode = .byCharWrapping
        textView.defaultParagraphStyle = paragraphStyle
        textView.typingAttributes[.paragraphStyle] = paragraphStyle
        if let storage = textView.textStorage, storage.length > 0 {
            storage.addAttribute(.paragraphStyle, value: paragraphStyle, range: NSRange(location: 0, length: storage.length))
        }

        let scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: fieldWidth, height: visibleHeight))
        scrollView.documentView = textView
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.borderType = .bezelBorder
        scrollView.autohidesScrollers = true

        return (scrollView, textView)
    }

    private func labeled(_ text: String, _ view: NSView) -> NSView {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 11)
        label.textColor = .secondaryLabelColor

        let column = NSStackView(views: [label, view])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 4
        return column
    }
}

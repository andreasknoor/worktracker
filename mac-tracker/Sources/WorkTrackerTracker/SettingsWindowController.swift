import AppKit

/// A real settings window — deliberately not an `NSAlert` accessory view.
/// NSAlert's modal accessory views have known rough edges hosting
/// interactive, editable controls: standard edit commands like Cmd+V paste
/// don't route correctly (there's no application main menu with an Edit
/// menu for the key-equivalent to match against), and key-repeat while
/// holding a character key behaves unreliably. A normal NSWindow
/// participates fully in the standard AppKit window/responder/menu system,
/// so text editing just works the way it does in any other app.
final class SettingsWindowController: NSWindowController {
    private let serverTextView = NSTextView()
    private let apiKeyTextView = NSTextView()
    private let pollField = NSTextField()
    private let onSave: (TrackerConfig) -> Void

    private static let fieldWidth: CGFloat = 460
    private static let wrappingParagraphStyle: NSParagraphStyle = {
        // Word-wrap alone won't break a single unbroken token (like an API
        // key with no spaces) across lines — character wrapping ensures it
        // wraps within the visible width instead of running off it.
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byCharWrapping
        return style
    }()

    init(config: TrackerConfig, onSave: @escaping (TrackerConfig) -> Void) {
        self.onSave = onSave

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 340),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "WorkTracker Settings"
        window.isReleasedWhenClosed = false

        super.init(window: window)

        buildContent()
        reload(config: config)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func reload(config: TrackerConfig) {
        Self.setWrappedText(config.serverBaseURL, in: serverTextView)
        Self.setWrappedText(config.apiKey, in: apiKeyTextView)
        pollField.stringValue = String(config.pollIntervalSeconds)
    }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        window?.makeFirstResponder(serverTextView)
    }

    private func buildContent() {
        guard let contentView = window?.contentView else { return }

        let infoLabel = NSTextField(wrappingLabelWithString: "Server URL and API key come from the dashboard's Devices panel.")
        infoLabel.font = .systemFont(ofSize: 12)
        infoLabel.textColor = .secondaryLabelColor

        let serverScroll = Self.configureWrappingField(serverTextView, height: 44)
        let apiKeyScroll = Self.configureWrappingField(apiKeyTextView, height: 76)

        pollField.translatesAutoresizingMaskIntoConstraints = false
        pollField.widthAnchor.constraint(equalToConstant: 100).isActive = true

        let saveButton = NSButton(title: "Save", target: self, action: #selector(save))
        saveButton.keyEquivalent = "\r"
        saveButton.bezelStyle = .rounded

        let cancelButton = NSButton(title: "Cancel", target: self, action: #selector(cancel))
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.bezelStyle = .rounded

        let buttonSpacer = NSView()
        let buttonRow = NSStackView(views: [buttonSpacer, cancelButton, saveButton])
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 8
        buttonSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let stack = NSStackView(views: [
            infoLabel,
            labeled("Server URL (e.g. https://your-project.vercel.app)", serverScroll),
            labeled("API Key", apiKeyScroll),
            labeled("Poll interval (seconds)", pollField),
            buttonRow,
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 16
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false

        contentView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            stack.topAnchor.constraint(equalTo: contentView.topAnchor),
            stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
            buttonRow.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40),
            infoLabel.widthAnchor.constraint(equalToConstant: Self.fieldWidth),
        ])
    }

    @objc private func save() {
        let pollInterval = Int(pollField.stringValue) ?? 30
        let updated = TrackerConfig(
            serverBaseURL: serverTextView.string.trimmingCharacters(in: .whitespacesAndNewlines),
            apiKey: apiKeyTextView.string.trimmingCharacters(in: .whitespacesAndNewlines),
            pollIntervalSeconds: max(5, pollInterval)
        )
        onSave(updated)
        window?.orderOut(nil)
    }

    @objc private func cancel() {
        window?.orderOut(nil)
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

    /// Sets a text view's content and (re-)applies the char-wrapping
    /// paragraph style to it. Setting `.string` directly replaces the text
    /// storage without picking up `typingAttributes` (those only apply to
    /// text typed afterwards), so this needs to be reapplied explicitly.
    private static func setWrappedText(_ text: String, in textView: NSTextView) {
        textView.string = text
        if let storage = textView.textStorage, storage.length > 0 {
            storage.addAttribute(.paragraphStyle, value: wrappingParagraphStyle, range: NSRange(location: 0, length: storage.length))
        }
    }

    /// Wraps `textView` in a fixed-size, vertically-scrollable NSScrollView.
    /// Generated API keys run 70+ characters — a single-line NSTextField
    /// only shows a fragment of one; this shows the whole value, wrapped,
    /// with scrolling for anything taller than the visible area.
    private static func configureWrappingField(_ textView: NSTextView, height: CGFloat) -> NSScrollView {
        textView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        textView.isEditable = true
        textView.isSelectable = true
        textView.isRichText = false
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.textContainer?.widthTracksTextView = true
        textView.allowsUndo = true
        textView.defaultParagraphStyle = wrappingParagraphStyle
        textView.typingAttributes[.paragraphStyle] = wrappingParagraphStyle

        let scrollView = NSScrollView()
        scrollView.documentView = textView
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.borderType = .bezelBorder
        scrollView.drawsBackground = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        // NSStackView lays out arranged subviews with Auto Layout, and
        // NSScrollView (unlike NSTextField) has no meaningful intrinsic
        // content size — without explicit constraints the stack collapses
        // it to zero size, making the field invisible even though it's
        // still "there".
        NSLayoutConstraint.activate([
            scrollView.widthAnchor.constraint(equalToConstant: fieldWidth),
            scrollView.heightAnchor.constraint(equalToConstant: height),
        ])

        return scrollView
    }
}

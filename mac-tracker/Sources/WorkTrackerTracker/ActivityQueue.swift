import Foundation

/// A small local queue of not-yet-sent activity timestamps, persisted to
/// disk so a network blip (or the tracker quitting) doesn't lose events —
/// see API_CONTRACT.md's note on why batched event posting exists. Flushing
/// only clears entries once the server has actually accepted them.
final class ActivityQueue {
    private var pending: [Date]
    private let storageURL: URL
    private let dateFormatter: ISO8601DateFormatter

    init(storageURL: URL) {
        self.storageURL = storageURL
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        self.dateFormatter = formatter
        self.pending = Self.load(from: storageURL, using: formatter)
    }

    var pendingCount: Int { pending.count }

    func enqueue(_ date: Date) {
        pending.append(date)
        persist()
    }

    /// Attempts to send every pending timestamp in one batch. On success the
    /// queue is cleared; on failure everything stays queued for the next
    /// flush attempt (the caller is expected to retry on a timer).
    func flush(client: EventsAPIClient, serverBaseURL: String, apiKey: String) async {
        guard !pending.isEmpty else { return }
        let batch = pending

        do {
            try await client.postEvents(batch, serverBaseURL: serverBaseURL, apiKey: apiKey)
            pending.removeAll()
            persist()
        } catch {
            // Left queued intentionally; a later flush will retry the same batch.
        }
    }

    private func persist() {
        let strings = pending.map { dateFormatter.string(from: $0) }
        guard let data = try? JSONEncoder().encode(strings) else { return }
        try? FileManager.default.createDirectory(
            at: storageURL.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try? data.write(to: storageURL, options: .atomic)
    }

    private static func load(from url: URL, using formatter: ISO8601DateFormatter) -> [Date] {
        guard let data = try? Data(contentsOf: url),
              let strings = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        return strings.compactMap { formatter.date(from: $0) }
    }
}

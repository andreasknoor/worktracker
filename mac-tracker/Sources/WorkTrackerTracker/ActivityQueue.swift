import Foundation

/// A small local queue of not-yet-sent activity timestamps, persisted to
/// disk so a network blip (or the tracker quitting) doesn't lose events —
/// see API_CONTRACT.md's note on why batched event posting exists. Flushing
/// only clears entries once the server has actually accepted them.
///
/// Two things keep this well-behaved during a sustained server outage:
///  - `flush()` backs off exponentially on repeated failures instead of
///    letting the caller's fixed-interval timer hammer the endpoint forever.
///  - `pending` is capped; once full, the oldest (least useful) timestamps
///    are dropped to make room for new ones, so a multi-hour+ outage can't
///    grow the queue (and its on-disk file) without bound.
final class ActivityQueue {
    /// Activity timestamps are cheap (a handful of bytes each), but an
    /// unbounded queue during a long outage would still grow forever. A few
    /// thousand entries comfortably covers a full day of poll-interval-paced
    /// activity ticks while keeping memory/disk use trivial.
    static let defaultMaxPendingCount = 5000

    /// Base delay before retrying after the *first* consecutive flush
    /// failure; doubles with each further consecutive failure (see
    /// `backoffInterval(forConsecutiveFailures:)`), capped at
    /// `defaultMaxBackoffIntervalSeconds`.
    static let defaultBaseBackoffIntervalSeconds: TimeInterval = 15

    /// Upper bound on the backoff delay, so a server outage lasting hours
    /// still gets retried a few times an hour rather than essentially never.
    static let defaultMaxBackoffIntervalSeconds: TimeInterval = 300

    /// Pending changes are batched to disk at most this often, to avoid
    /// rewriting the whole queue file on every single `enqueue()` call.
    /// Losing the last few seconds of unpersisted state in a crash (as
    /// opposed to a graceful quit, which calls `persistNow()`) is an
    /// acceptable trade-off for activity timestamps.
    static let defaultPersistDebounceIntervalSeconds: TimeInterval = 5

    private var pending: [Date]
    private let storageURL: URL
    private let dateFormatter: ISO8601DateFormatter
    private let maxPendingCount: Int
    private let baseBackoffInterval: TimeInterval
    private let maxBackoffInterval: TimeInterval
    private let persistDebounceInterval: TimeInterval
    private let now: () -> Date

    private var lastPersistedAt: Date?
    private var hasUnpersistedChanges = false
    private var consecutiveFailureCount = 0
    private var nextAllowedFlushAt: Date?

    init(
        storageURL: URL,
        maxPendingCount: Int = ActivityQueue.defaultMaxPendingCount,
        baseBackoffInterval: TimeInterval = ActivityQueue.defaultBaseBackoffIntervalSeconds,
        maxBackoffInterval: TimeInterval = ActivityQueue.defaultMaxBackoffIntervalSeconds,
        persistDebounceInterval: TimeInterval = ActivityQueue.defaultPersistDebounceIntervalSeconds,
        now: @escaping () -> Date = Date.init
    ) {
        self.storageURL = storageURL
        self.maxPendingCount = maxPendingCount
        self.baseBackoffInterval = baseBackoffInterval
        self.maxBackoffInterval = maxBackoffInterval
        self.persistDebounceInterval = persistDebounceInterval
        self.now = now
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        self.dateFormatter = formatter
        self.pending = Self.load(from: storageURL, using: formatter)
    }

    var pendingCount: Int { pending.count }

    /// Exposed for tests to inspect which timestamps survived cap eviction;
    /// production callers only need `pendingCount`.
    var pendingTimestamps: [Date] { pending }

    /// Number of flush attempts that have failed in a row since the last
    /// success (or since the queue was created). Exposed for tests.
    var currentConsecutiveFailureCount: Int { consecutiveFailureCount }

    func enqueue(_ date: Date) {
        pending.append(date)
        if pending.count > maxPendingCount {
            pending.removeFirst(pending.count - maxPendingCount)
        }
        hasUnpersistedChanges = true
        persistIfDebounceElapsed()
    }

    /// Attempts to send every pending timestamp in one batch. On success the
    /// queue is cleared and the backoff state resets; on failure everything
    /// stays queued and the delay before the *next* attempt is actually
    /// allowed to run grows exponentially, so a sustained outage doesn't
    /// hammer the endpoint at the caller's fixed timer interval forever.
    ///
    /// The caller (AppDelegate's fixed-interval timer) can keep calling this
    /// on every tick without checking backoff state itself — a call that
    /// arrives before `nextAllowedFlushAt` is simply a cheap no-op.
    func flush(client: EventsAPIClient, serverBaseURL: String, apiKey: String) async {
        guard !pending.isEmpty else { return }
        if let nextAllowedFlushAt, now() < nextAllowedFlushAt { return }

        let batch = pending

        do {
            try await client.postEvents(batch, serverBaseURL: serverBaseURL, apiKey: apiKey)
            pending.removeAll()
            consecutiveFailureCount = 0
            nextAllowedFlushAt = nil
            hasUnpersistedChanges = true
            persist()
        } catch {
            consecutiveFailureCount += 1
            let delay = Self.backoffInterval(
                forConsecutiveFailures: consecutiveFailureCount,
                base: baseBackoffInterval,
                max: maxBackoffInterval
            )
            nextAllowedFlushAt = now().addingTimeInterval(delay)
        }
    }

    /// Doubles the delay with each consecutive failure (1st failure: base,
    /// 2nd: 2x base, 3rd: 4x base, ...), capped at `max`.
    static func backoffInterval(forConsecutiveFailures count: Int, base: TimeInterval, max: TimeInterval) -> TimeInterval {
        guard count > 0 else { return 0 }
        let multiplier = pow(2.0, Double(count - 1))
        return Swift.min(base * multiplier, max)
    }

    /// Forces any pending in-memory changes to disk immediately, bypassing
    /// the debounce window. Call this on graceful app termination so the
    /// worst case data loss is limited to a crash between debounce windows,
    /// not a normal quit.
    func persistNow() {
        guard hasUnpersistedChanges else { return }
        persist()
    }

    private func persistIfDebounceElapsed() {
        if let lastPersistedAt, now().timeIntervalSince(lastPersistedAt) < persistDebounceInterval {
            return
        }
        persist()
    }

    private func persist() {
        let strings = pending.map { dateFormatter.string(from: $0) }
        guard let data = try? JSONEncoder().encode(strings) else { return }
        try? FileManager.default.createDirectory(
            at: storageURL.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try? data.write(to: storageURL, options: .atomic)
        lastPersistedAt = now()
        hasUnpersistedChanges = false
    }

    private static func load(from url: URL, using formatter: ISO8601DateFormatter) -> [Date] {
        guard let data = try? Data(contentsOf: url),
              let strings = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        return strings.compactMap { formatter.date(from: $0) }
    }
}

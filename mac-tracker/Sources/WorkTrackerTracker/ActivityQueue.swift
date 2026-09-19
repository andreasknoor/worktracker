import Foundation

/// A small local queue of not-yet-sent activity timestamps, persisted to
/// disk so a network blip (or the tracker quitting) doesn't lose events —
/// see API_CONTRACT.md's note on why batched event posting exists. Only
/// entries the server has actually accepted are ever removed.
///
/// Behavior during a sustained server outage (kept in sync with the Windows
/// tracker's `ActivityQueue.cs`):
///  - `flush()` sends in chunks of at most `chunkSize` timestamps, well
///    under the server's per-request cap, and removes each chunk as soon
///    as it's acknowledged — so a huge backlog drains in pieces instead of
///    being rejected as one oversized request.
///  - Only the entries that were actually sent are removed; timestamps
///    enqueued while a request was in flight stay queued.
///  - Repeated failures back off exponentially instead of letting the
///    caller's fixed-interval timer hammer the endpoint.
///  - A chunk the server rejects as invalid (HTTP 400/413/422) is dropped
///    rather than retried forever, so it can't block everything behind it.
///  - `pending` is capped very generously; once full the oldest entries
///    are dropped and counted in `droppedEventCount`.
///
/// Thread-safety: `enqueue` runs on the main thread, `flush` on whatever
/// executor its `Task` lands on; shared state is guarded by `lock`, which
/// is never held across an `await`.
final class ActivityQueue {
    /// Timestamps are ~30 bytes each on disk, so 100k entries is ~3 MB —
    /// enough for weeks of activity at the default poll interval — while
    /// still bounding memory/disk use if the server is gone for good.
    static let defaultMaxPendingCount = 100_000

    /// Timestamps per request. Must stay at or below the server's
    /// per-request cap (`MAX_EVENTS_PER_REQUEST` in src/server/app.ts).
    static let defaultChunkSize = 1000

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
    private let chunkSize: Int
    private let baseBackoffInterval: TimeInterval
    private let maxBackoffInterval: TimeInterval
    private let persistDebounceInterval: TimeInterval
    private let now: () -> Date

    private var lastPersistedAt: Date?
    private var hasUnpersistedChanges = false
    private var consecutiveFailureCount = 0
    private var nextAllowedFlushAt: Date?
    private var isFlushing = false
    private let lock = NSLock()

    /// Monotonic sequence number of `pending[0]`. Lets a flush remove
    /// exactly the entries it sent even if cap eviction shifted the front
    /// of the queue while the request was in flight.
    private var headSequence = 0

    /// Human-readable reason the most recent flush failed, or nil after a
    /// success. Shown in the status menu.
    private(set) var lastError: String?

    /// Total entries discarded this session: evicted by the cap, or
    /// rejected by the server as invalid.
    private(set) var droppedEventCount = 0

    /// When the last batch was actually accepted by the server — not just
    /// attempted. Persisted across restarts (in the same queue file) so the
    /// status item shows an accurate value immediately after launch, not
    /// "Never synced" just because this process hasn't flushed yet.
    private(set) var lastSuccessfulSyncAt: Date?

    init(
        storageURL: URL,
        maxPendingCount: Int = ActivityQueue.defaultMaxPendingCount,
        chunkSize: Int = ActivityQueue.defaultChunkSize,
        baseBackoffInterval: TimeInterval = ActivityQueue.defaultBaseBackoffIntervalSeconds,
        maxBackoffInterval: TimeInterval = ActivityQueue.defaultMaxBackoffIntervalSeconds,
        persistDebounceInterval: TimeInterval = ActivityQueue.defaultPersistDebounceIntervalSeconds,
        now: @escaping () -> Date = Date.init
    ) {
        self.storageURL = storageURL
        self.maxPendingCount = maxPendingCount
        self.chunkSize = max(1, chunkSize)
        self.baseBackoffInterval = baseBackoffInterval
        self.maxBackoffInterval = maxBackoffInterval
        self.persistDebounceInterval = persistDebounceInterval
        self.now = now
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        self.dateFormatter = formatter
        let loaded = Self.load(from: storageURL, using: formatter)
        self.pending = loaded.pending
        self.lastSuccessfulSyncAt = loaded.lastSuccessfulSyncAt
    }

    var pendingCount: Int { lock.withLock { pending.count } }

    /// Exposed for tests to inspect which timestamps survived cap eviction;
    /// production callers only need `pendingCount`.
    var pendingTimestamps: [Date] { lock.withLock { pending } }

    /// Number of flush attempts that have failed in a row since the last
    /// success (or since the queue was created). Exposed for tests.
    var currentConsecutiveFailureCount: Int { lock.withLock { consecutiveFailureCount } }

    func enqueue(_ date: Date) {
        lock.withLock {
            pending.append(date)
            if pending.count > maxPendingCount {
                let overflow = pending.count - maxPendingCount
                pending.removeFirst(overflow)
                headSequence += overflow
                droppedEventCount += overflow
            }
            hasUnpersistedChanges = true
            persistIfDebounceElapsed()
        }
    }

    /// Sends everything pending, one chunk at a time, stopping at the first
    /// failure. A call that arrives while another flush is running, or
    /// before `nextAllowedFlushAt`, is a cheap no-op, so the caller's
    /// fixed-interval timer can call this on every tick unconditionally.
    func flush(client: EventsAPIClient, serverBaseURL: String, apiKey: String) async {
        guard beginFlush() else { return }
        defer { lock.withLock { isFlushing = false } }

        while let chunk = nextChunk() {
            do {
                try await client.postEvents(chunk.timestamps, serverBaseURL: serverBaseURL, apiKey: apiKey)
                completeChunk(endSequence: chunk.endSequence, rejected: false)
            } catch let error as APIClientError where error.isPermanentRejection {
                // The server understood the request and refuses this data;
                // retrying the same chunk would block the queue forever.
                completeChunk(endSequence: chunk.endSequence, rejected: true)
                lock.withLock { lastError = "Server rejected \(chunk.timestamps.count) event(s) as invalid" }
            } catch {
                recordFailure(error)
                return
            }
        }
    }

    private func beginFlush() -> Bool {
        lock.withLock {
            guard !isFlushing, !pending.isEmpty else { return false }
            if let nextAllowedFlushAt, now() < nextAllowedFlushAt { return false }
            isFlushing = true
            return true
        }
    }

    private func nextChunk() -> (timestamps: [Date], endSequence: Int)? {
        lock.withLock {
            guard !pending.isEmpty else { return nil }
            let chunk = Array(pending.prefix(chunkSize))
            return (chunk, headSequence + chunk.count)
        }
    }

    /// Removes exactly the entries up to `endSequence` — never more, so
    /// timestamps enqueued (or already evicted) meanwhile are untouched.
    private func completeChunk(endSequence: Int, rejected: Bool) {
        lock.withLock {
            let removable = min(max(0, endSequence - headSequence), pending.count)
            pending.removeFirst(removable)
            headSequence += removable
            if rejected {
                droppedEventCount += removable
            } else {
                consecutiveFailureCount = 0
                nextAllowedFlushAt = nil
                lastError = nil
                lastSuccessfulSyncAt = now()
            }
            hasUnpersistedChanges = true
            persist()
        }
    }

    private func recordFailure(_ error: Error) {
        lock.withLock {
            consecutiveFailureCount += 1
            let delay = Self.backoffInterval(
                forConsecutiveFailures: consecutiveFailureCount,
                base: baseBackoffInterval,
                max: maxBackoffInterval
            )
            nextAllowedFlushAt = now().addingTimeInterval(delay)
            lastError = Self.describe(error)
        }
    }

    private static func describe(_ error: Error) -> String {
        switch error as? APIClientError {
        case .unauthorized: return "API key invalid or revoked"
        case .invalidServerURL: return "Invalid server URL"
        case .requestFailed(let status) where status > 0: return "Server error (HTTP \(status))"
        default: return "Server unreachable"
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
        lock.withLock {
            guard hasUnpersistedChanges else { return }
            persist()
        }
    }

    private func persistIfDebounceElapsed() {
        if let lastPersistedAt, now().timeIntervalSince(lastPersistedAt) < persistDebounceInterval {
            return
        }
        persist()
    }

    /// Caller must hold `lock`. Writes atomically (temp file + rename), so
    /// a crash mid-write can't leave a truncated queue file. A failed write
    /// leaves `hasUnpersistedChanges` set so the next attempt retries.
    private func persist() {
        let state = PersistedState(
            pending: pending.map { dateFormatter.string(from: $0) },
            lastSuccessfulSyncAt: lastSuccessfulSyncAt.map { dateFormatter.string(from: $0) }
        )
        do {
            let data = try JSONEncoder().encode(state)
            try FileManager.default.createDirectory(
                at: storageURL.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try data.write(to: storageURL, options: .atomic)
            hasUnpersistedChanges = false
        } catch {
            hasUnpersistedChanges = true
        }
        lastPersistedAt = now()
    }

    /// The on-disk shape. Kept separate from `[Date]`/`Date` so it can be
    /// `Codable` without teaching `Date` to round-trip through the same
    /// `ISO8601DateFormatter` this class already uses elsewhere.
    private struct PersistedState: Codable {
        var pending: [String]
        var lastSuccessfulSyncAt: String?
    }

    private static func load(from url: URL, using formatter: ISO8601DateFormatter) -> (pending: [Date], lastSuccessfulSyncAt: Date?) {
        guard let data = try? Data(contentsOf: url) else { return ([], nil) }

        if let state = try? JSONDecoder().decode(PersistedState.self, from: data) {
            let pending = state.pending.compactMap { formatter.date(from: $0) }
            let lastSync = state.lastSuccessfulSyncAt.flatMap { formatter.date(from: $0) }
            return (pending, lastSync)
        }

        // Older queue files are a bare `[String]` of pending timestamps
        // (no lastSuccessfulSyncAt yet) — fall back to that shape so
        // upgrading doesn't drop an existing queue.
        if let strings = try? JSONDecoder().decode([String].self, from: data) {
            return (strings.compactMap { formatter.date(from: $0) }, nil)
        }

        // Neither shape parsed: keep the unreadable file for manual
        // recovery instead of silently overwriting it with an empty queue.
        let quarantine = url.appendingPathExtension("corrupt")
        try? FileManager.default.removeItem(at: quarantine)
        try? FileManager.default.moveItem(at: url, to: quarantine)
        return ([], nil)
    }
}

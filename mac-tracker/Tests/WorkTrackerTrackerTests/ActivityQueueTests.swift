import XCTest
@testable import WorkTrackerTracker

private final class FakeEventsAPIClient: EventsAPIClient {
    var shouldFail = false
    var failure: APIClientError = .requestFailed(statusCode: 500)
    /// Runs while a request is "in flight", to simulate activity arriving mid-flush.
    var onPost: (() -> Void)?
    private(set) var receivedBatches: [[Date]] = []

    func postEvents(_ timestamps: [Date], serverBaseURL: String, apiKey: String) async throws {
        receivedBatches.append(timestamps)
        onPost?()
        if shouldFail {
            throw failure
        }
    }
}

/// A controllable clock so backoff/debounce timing can be tested without
/// real `Timer`s or `sleep`s — mirrors how `SystemIdleTimeSource` is faked
/// for `IdleMonitor` in IdleMonitorTests.swift.
private final class FakeClock {
    var current: Date
    init(_ current: Date = Date(timeIntervalSince1970: 0)) { self.current = current }
    func advance(by seconds: TimeInterval) { current = current.addingTimeInterval(seconds) }
    func now() -> Date { current }
}

final class ActivityQueueTests: XCTestCase {
    private var tempURL: URL!

    override func setUp() {
        super.setUp()
        tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("queue.json")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempURL.deletingLastPathComponent())
        super.tearDown()
    }

    // MARK: - Basic enqueue/flush behavior

    func test_newQueue_startsEmpty() {
        let queue = ActivityQueue(storageURL: tempURL)
        XCTAssertEqual(queue.pendingCount, 0)
    }

    func test_enqueue_incrementsPendingCount() {
        let queue = ActivityQueue(storageURL: tempURL)
        queue.enqueue(Date())
        queue.enqueue(Date())
        XCTAssertEqual(queue.pendingCount, 2)
    }

    func test_flush_onSuccess_clearsTheQueueAndSendsOneBatch() async {
        let queue = ActivityQueue(storageURL: tempURL)
        queue.enqueue(Date())
        queue.enqueue(Date())
        let client = FakeEventsAPIClient()

        await queue.flush(client: client, serverBaseURL: "https://example.vercel.app", apiKey: "wtk_live_x")

        XCTAssertEqual(queue.pendingCount, 0)
        XCTAssertEqual(client.receivedBatches.count, 1)
        XCTAssertEqual(client.receivedBatches[0].count, 2)
    }

    func test_flush_onFailure_keepsEventsQueuedForRetry() async {
        let queue = ActivityQueue(storageURL: tempURL)
        queue.enqueue(Date())
        let client = FakeEventsAPIClient()
        client.shouldFail = true

        await queue.flush(client: client, serverBaseURL: "https://example.vercel.app", apiKey: "wtk_live_x")

        XCTAssertEqual(queue.pendingCount, 1)
    }

    // MARK: - lastSuccessfulSyncAt

    func test_lastSuccessfulSyncAt_isNilInitially() {
        let queue = ActivityQueue(storageURL: tempURL)
        XCTAssertNil(queue.lastSuccessfulSyncAt)
    }

    func test_flush_onSuccess_setsLastSuccessfulSyncAt() async {
        let clock = FakeClock()
        let queue = ActivityQueue(storageURL: tempURL, now: clock.now)
        queue.enqueue(clock.now())
        clock.advance(by: 42)

        await queue.flush(client: FakeEventsAPIClient(), serverBaseURL: "https://example.vercel.app", apiKey: "k")

        XCTAssertEqual(queue.lastSuccessfulSyncAt, clock.now())
    }

    func test_flush_onFailure_doesNotSetLastSuccessfulSyncAt() async {
        let queue = ActivityQueue(storageURL: tempURL)
        queue.enqueue(Date())
        let client = FakeEventsAPIClient()
        client.shouldFail = true

        await queue.flush(client: client, serverBaseURL: "https://example.vercel.app", apiKey: "k")

        XCTAssertNil(queue.lastSuccessfulSyncAt)
    }

    func test_lastSuccessfulSyncAt_survivesRestart_byPersistingToDisk() async {
        // A whole-second FakeClock value, not the real system clock: ISO
        // 8601 round-tripping only preserves millisecond precision, so
        // comparing against `Date()`'s full (sub-millisecond) precision
        // would be a flaky equality check.
        let clock = FakeClock()
        let firstInstance = ActivityQueue(storageURL: tempURL, persistDebounceInterval: 0, now: clock.now)
        firstInstance.enqueue(clock.now())
        await firstInstance.flush(client: FakeEventsAPIClient(), serverBaseURL: "https://example.vercel.app", apiKey: "k")

        let secondInstance = ActivityQueue(storageURL: tempURL)
        XCTAssertEqual(secondInstance.lastSuccessfulSyncAt, clock.now())
    }

    func test_loadsAnOlderQueueFile_writtenBeforeLastSuccessfulSyncAtExisted() throws {
        // Pre-upgrade queue files are a bare `[String]` of ISO 8601
        // timestamps, with no lastSuccessfulSyncAt field at all.
        try FileManager.default.createDirectory(at: tempURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let legacyJSON = try JSONEncoder().encode([formatter.string(from: Date())])
        try legacyJSON.write(to: tempURL)

        let queue = ActivityQueue(storageURL: tempURL)

        XCTAssertEqual(queue.pendingCount, 1, "the legacy pending entry should still load")
        XCTAssertNil(queue.lastSuccessfulSyncAt, "an old file has no sync history to report")
    }

    func test_flush_onEmptyQueue_doesNotCallTheClient() async {
        let queue = ActivityQueue(storageURL: tempURL)
        let client = FakeEventsAPIClient()

        await queue.flush(client: client, serverBaseURL: "https://example.vercel.app", apiKey: "wtk_live_x")

        XCTAssertEqual(client.receivedBatches.count, 0)
    }

    // MARK: - Persistence round-trip (debounce disabled so writes are synchronous)

    func test_queueSurvivesRestart_byPersistingToDisk() {
        let firstInstance = ActivityQueue(storageURL: tempURL, persistDebounceInterval: 0)
        firstInstance.enqueue(Date())
        firstInstance.enqueue(Date())

        let secondInstance = ActivityQueue(storageURL: tempURL)
        XCTAssertEqual(secondInstance.pendingCount, 2)
    }

    func test_afterSuccessfulFlush_aFreshInstanceHasNothingQueued() async {
        let firstInstance = ActivityQueue(storageURL: tempURL, persistDebounceInterval: 0)
        firstInstance.enqueue(Date())
        await firstInstance.flush(client: FakeEventsAPIClient(), serverBaseURL: "https://example.vercel.app", apiKey: "k")

        let secondInstance = ActivityQueue(storageURL: tempURL)
        XCTAssertEqual(secondInstance.pendingCount, 0)
    }

    // MARK: - Persistence debouncing

    func test_enqueue_withinDebounceWindow_doesNotPersistImmediately() {
        let clock = FakeClock()
        let firstInstance = ActivityQueue(
            storageURL: tempURL, persistDebounceInterval: 5, now: clock.now
        )
        firstInstance.enqueue(Date()) // first write always persists (no prior persist yet)
        clock.advance(by: 1) // still well within the 5s debounce window
        firstInstance.enqueue(Date())

        let secondInstance = ActivityQueue(storageURL: tempURL)
        XCTAssertEqual(secondInstance.pendingCount, 1, "the second enqueue should still be debounced, not yet on disk")
    }

    func test_enqueue_afterDebounceWindowElapses_persists() {
        let clock = FakeClock()
        let firstInstance = ActivityQueue(
            storageURL: tempURL, persistDebounceInterval: 5, now: clock.now
        )
        firstInstance.enqueue(Date())
        clock.advance(by: 6) // past the debounce window
        firstInstance.enqueue(Date())

        let secondInstance = ActivityQueue(storageURL: tempURL)
        XCTAssertEqual(secondInstance.pendingCount, 2)
    }

    func test_persistNow_flushesDebouncedChangesImmediately() {
        let clock = FakeClock()
        let firstInstance = ActivityQueue(
            storageURL: tempURL, persistDebounceInterval: 5, now: clock.now
        )
        firstInstance.enqueue(Date())
        clock.advance(by: 1)
        firstInstance.enqueue(Date()) // debounced, not yet on disk
        firstInstance.persistNow() // e.g. called from applicationWillTerminate

        let secondInstance = ActivityQueue(storageURL: tempURL)
        XCTAssertEqual(secondInstance.pendingCount, 2)
    }

    // MARK: - Queue cap / oldest eviction

    func test_enqueue_beyondCap_dropsOldestEntriesFirst() {
        let queue = ActivityQueue(storageURL: tempURL, maxPendingCount: 3, persistDebounceInterval: 0)
        let base = Date(timeIntervalSince1970: 0)
        let timestamps = (0..<5).map { base.addingTimeInterval(TimeInterval($0)) }

        for timestamp in timestamps {
            queue.enqueue(timestamp)
        }

        XCTAssertEqual(queue.pendingCount, 3)
        // The two oldest (index 0 and 1) should have been evicted, keeping
        // the three most recent.
        XCTAssertEqual(queue.pendingTimestamps, Array(timestamps.suffix(3)))
    }

    func test_enqueue_beyondCap_survivesRestartWithOnlyNewestEntries() {
        let firstInstance = ActivityQueue(storageURL: tempURL, maxPendingCount: 2, persistDebounceInterval: 0)
        let base = Date(timeIntervalSince1970: 0)
        firstInstance.enqueue(base)
        firstInstance.enqueue(base.addingTimeInterval(1))
        firstInstance.enqueue(base.addingTimeInterval(2))

        let secondInstance = ActivityQueue(storageURL: tempURL)
        XCTAssertEqual(secondInstance.pendingCount, 2)
        XCTAssertEqual(secondInstance.pendingTimestamps, [base.addingTimeInterval(1), base.addingTimeInterval(2)])
    }

    // MARK: - Flush backoff on repeated failures

    func test_flush_afterFailure_skipsRetryUntilBackoffElapses() async {
        let clock = FakeClock()
        let queue = ActivityQueue(
            storageURL: tempURL, baseBackoffInterval: 10, maxBackoffInterval: 300, now: clock.now
        )
        queue.enqueue(Date())
        let client = FakeEventsAPIClient()
        client.shouldFail = true

        await queue.flush(client: client, serverBaseURL: "https://example.vercel.app", apiKey: "k")
        XCTAssertEqual(client.receivedBatches.count, 1)
        XCTAssertEqual(queue.currentConsecutiveFailureCount, 1)

        // A retry attempted before the backoff window elapses should be a
        // no-op — the client must not be called again yet.
        clock.advance(by: 5)
        await queue.flush(client: client, serverBaseURL: "https://example.vercel.app", apiKey: "k")
        XCTAssertEqual(client.receivedBatches.count, 1, "should still be backing off")

        // Once the backoff window elapses, the next flush should retry.
        clock.advance(by: 6) // total 11s since the failure, past the 10s base backoff
        await queue.flush(client: client, serverBaseURL: "https://example.vercel.app", apiKey: "k")
        XCTAssertEqual(client.receivedBatches.count, 2)
        XCTAssertEqual(queue.currentConsecutiveFailureCount, 2)
    }

    func test_flush_backoff_doublesWithEachConsecutiveFailureUpToCap() {
        let base: TimeInterval = 10
        let max: TimeInterval = 100
        XCTAssertEqual(ActivityQueue.backoffInterval(forConsecutiveFailures: 1, base: base, max: max), 10)
        XCTAssertEqual(ActivityQueue.backoffInterval(forConsecutiveFailures: 2, base: base, max: max), 20)
        XCTAssertEqual(ActivityQueue.backoffInterval(forConsecutiveFailures: 3, base: base, max: max), 40)
        XCTAssertEqual(ActivityQueue.backoffInterval(forConsecutiveFailures: 4, base: base, max: max), 80)
        // Would be 160 uncapped; the max caps it.
        XCTAssertEqual(ActivityQueue.backoffInterval(forConsecutiveFailures: 5, base: base, max: max), 100)
        XCTAssertEqual(ActivityQueue.backoffInterval(forConsecutiveFailures: 6, base: base, max: max), 100)
    }

    func test_flush_onSuccess_resetsBackoffState() async {
        let clock = FakeClock()
        let queue = ActivityQueue(
            storageURL: tempURL, baseBackoffInterval: 10, maxBackoffInterval: 300, now: clock.now
        )
        queue.enqueue(Date())
        let client = FakeEventsAPIClient()
        client.shouldFail = true
        await queue.flush(client: client, serverBaseURL: "https://example.vercel.app", apiKey: "k")
        XCTAssertEqual(queue.currentConsecutiveFailureCount, 1)

        client.shouldFail = false
        clock.advance(by: 20) // past the backoff window so this attempt actually runs
        queue.enqueue(Date())
        await queue.flush(client: client, serverBaseURL: "https://example.vercel.app", apiKey: "k")

        XCTAssertEqual(queue.currentConsecutiveFailureCount, 0)
        XCTAssertEqual(queue.pendingCount, 0)

        // A subsequent failure should back off starting from the base
        // interval again, not continue escalating from before the reset.
        client.shouldFail = true
        queue.enqueue(Date())
        await queue.flush(client: client, serverBaseURL: "https://example.vercel.app", apiKey: "k")
        XCTAssertEqual(queue.currentConsecutiveFailureCount, 1)
    }

    // MARK: - Outage resilience

    private let url = "https://example.vercel.app"

    func test_flush_sendsLargeBacklogInChunks_andClearsAll() async {
        let queue = ActivityQueue(storageURL: tempURL, chunkSize: 100, persistDebounceInterval: 0)
        for i in 0..<250 { queue.enqueue(Date(timeIntervalSince1970: TimeInterval(i))) }
        let client = FakeEventsAPIClient()

        await queue.flush(client: client, serverBaseURL: url, apiKey: "k")

        XCTAssertEqual(client.receivedBatches.map(\.count), [100, 100, 50])
        XCTAssertEqual(queue.pendingCount, 0)
    }

    func test_flush_failureMidBacklog_keepsOnlyUnsentChunks() async {
        let queue = ActivityQueue(storageURL: tempURL, chunkSize: 100, persistDebounceInterval: 0)
        for i in 0..<250 { queue.enqueue(Date(timeIntervalSince1970: TimeInterval(i))) }
        let client = FakeEventsAPIClient()
        var calls = 0
        client.onPost = { calls += 1; client.shouldFail = calls >= 2 }

        await queue.flush(client: client, serverBaseURL: url, apiKey: "k")

        XCTAssertEqual(queue.pendingCount, 150, "first chunk acknowledged, the rest stay queued")
        XCTAssertEqual(queue.pendingTimestamps.first, Date(timeIntervalSince1970: 100))
    }

    func test_flush_keepsEventsEnqueuedWhileRequestIsInFlight() async {
        let queue = ActivityQueue(storageURL: tempURL, persistDebounceInterval: 0)
        queue.enqueue(Date(timeIntervalSince1970: 1))
        let client = FakeEventsAPIClient()
        var injected = false
        client.onPost = {
            guard !injected else { return }
            injected = true
            queue.enqueue(Date(timeIntervalSince1970: 2))
        }

        await queue.flush(client: client, serverBaseURL: url, apiKey: "k")

        XCTAssertEqual(client.receivedBatches.first, [Date(timeIntervalSince1970: 1)])
        // The late arrival is sent by the same flush's next chunk, not lost.
        XCTAssertEqual(client.receivedBatches.flatMap { $0 }.count, 2)
        XCTAssertEqual(queue.pendingCount, 0)
    }

    func test_flush_capEvictionDuringFlight_doesNotRemoveUnsentEntries() async {
        let queue = ActivityQueue(storageURL: tempURL, maxPendingCount: 3, persistDebounceInterval: 0)
        for i in 0..<3 { queue.enqueue(Date(timeIntervalSince1970: TimeInterval(i))) }
        let client = FakeEventsAPIClient()
        // The post covers entries 0..2, but 0 and 1 are evicted meanwhile:
        // only entry 2 may be removed; 3 and 4 must stay and be sent next.
        var first = true
        client.onPost = {
            guard first else { return }
            first = false
            queue.enqueue(Date(timeIntervalSince1970: 3))
            queue.enqueue(Date(timeIntervalSince1970: 4))
        }

        await queue.flush(client: client, serverBaseURL: url, apiKey: "k")

        XCTAssertEqual(queue.pendingCount, 0)
        XCTAssertEqual(client.receivedBatches.flatMap { $0 }.last, Date(timeIntervalSince1970: 4))
    }

    func test_flush_permanentRejection_dropsChunkAndContinues() async {
        let queue = ActivityQueue(storageURL: tempURL, chunkSize: 2, persistDebounceInterval: 0)
        for i in 0..<4 { queue.enqueue(Date(timeIntervalSince1970: TimeInterval(i))) }
        let client = FakeEventsAPIClient()
        var calls = 0
        client.failure = .requestFailed(statusCode: 400)
        client.onPost = { calls += 1; client.shouldFail = calls == 1 }

        await queue.flush(client: client, serverBaseURL: url, apiKey: "k")

        XCTAssertEqual(queue.pendingCount, 0, "poison chunk dropped, next chunk still delivered")
        XCTAssertEqual(queue.droppedEventCount, 2)
        XCTAssertEqual(client.receivedBatches.count, 2)
    }

    func test_flush_unauthorized_backsOffAndReportsError() async {
        let queue = ActivityQueue(storageURL: tempURL)
        queue.enqueue(Date())
        let client = FakeEventsAPIClient()
        client.shouldFail = true
        client.failure = .unauthorized

        await queue.flush(client: client, serverBaseURL: url, apiKey: "k")

        XCTAssertEqual(queue.pendingCount, 1, "never drop data because of a bad key")
        XCTAssertEqual(queue.lastError, "API key invalid or revoked")
        XCTAssertEqual(queue.currentConsecutiveFailureCount, 1)
    }

    func test_flush_success_clearsLastError() async {
        let clock = FakeClock()
        let queue = ActivityQueue(storageURL: tempURL, baseBackoffInterval: 10, now: clock.now)
        queue.enqueue(Date())
        let client = FakeEventsAPIClient()
        client.shouldFail = true
        await queue.flush(client: client, serverBaseURL: url, apiKey: "k")
        XCTAssertNotNil(queue.lastError)

        client.shouldFail = false
        clock.advance(by: 20)
        await queue.flush(client: client, serverBaseURL: url, apiKey: "k")

        XCTAssertNil(queue.lastError)
    }

    func test_enqueue_beyondCap_countsDroppedEvents() {
        let queue = ActivityQueue(storageURL: tempURL, maxPendingCount: 2, persistDebounceInterval: 0)
        for i in 0..<5 { queue.enqueue(Date(timeIntervalSince1970: TimeInterval(i))) }
        XCTAssertEqual(queue.droppedEventCount, 3)
    }

    func test_load_corruptQueueFile_isQuarantinedNotOverwritten() throws {
        try FileManager.default.createDirectory(at: tempURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{not json".utf8).write(to: tempURL)

        let queue = ActivityQueue(storageURL: tempURL)
        queue.enqueue(Date())
        queue.persistNow()

        XCTAssertEqual(queue.pendingCount, 1)
        let quarantined = tempURL.appendingPathExtension("corrupt")
        XCTAssertEqual(try String(contentsOf: quarantined, encoding: .utf8), "{not json")
    }

    // MARK: - Backward compatibility

    func test_existingQueueFileWith3000Events_loadsAndIsFullyDeliveredInChunks() async throws {
        // The shape the previous version wrote: {"pending": [...], "lastSuccessfulSyncAt": "..."}.
        try FileManager.default.createDirectory(at: tempURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let stamps = (0..<3000).map { formatter.string(from: Date(timeIntervalSince1970: 1_700_000_000 + TimeInterval($0 * 30))) }
        let json = try JSONSerialization.data(withJSONObject: ["pending": stamps, "lastSuccessfulSyncAt": "2026-01-01T00:00:00.000Z"])
        try json.write(to: tempURL)

        let queue = ActivityQueue(storageURL: tempURL)
        XCTAssertEqual(queue.pendingCount, 3000)
        XCTAssertNotNil(queue.lastSuccessfulSyncAt)

        let client = FakeEventsAPIClient()
        await queue.flush(client: client, serverBaseURL: url, apiKey: "k")

        XCTAssertEqual(client.receivedBatches.map(\.count).reduce(0, +), 3000)
        XCTAssertTrue(client.receivedBatches.allSatisfy { $0.count <= ActivityQueue.defaultChunkSize })
        XCTAssertEqual(queue.pendingCount, 0)
    }
}

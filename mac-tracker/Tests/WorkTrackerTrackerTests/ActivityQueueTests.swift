import XCTest
@testable import WorkTrackerTracker

private final class FakeEventsAPIClient: EventsAPIClient {
    var shouldFail = false
    private(set) var receivedBatches: [[Date]] = []

    func postEvents(_ timestamps: [Date], serverBaseURL: String, apiKey: String) async throws {
        receivedBatches.append(timestamps)
        if shouldFail {
            throw APIClientError.requestFailed(statusCode: 500)
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
}

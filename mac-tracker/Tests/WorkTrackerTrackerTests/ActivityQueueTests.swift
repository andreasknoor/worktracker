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

    func test_queueSurvivesRestart_byPersistingToDisk() {
        let firstInstance = ActivityQueue(storageURL: tempURL)
        firstInstance.enqueue(Date())
        firstInstance.enqueue(Date())

        let secondInstance = ActivityQueue(storageURL: tempURL)
        XCTAssertEqual(secondInstance.pendingCount, 2)
    }

    func test_afterSuccessfulFlush_aFreshInstanceHasNothingQueued() async {
        let firstInstance = ActivityQueue(storageURL: tempURL)
        firstInstance.enqueue(Date())
        await firstInstance.flush(client: FakeEventsAPIClient(), serverBaseURL: "https://example.vercel.app", apiKey: "k")

        let secondInstance = ActivityQueue(storageURL: tempURL)
        XCTAssertEqual(secondInstance.pendingCount, 0)
    }
}

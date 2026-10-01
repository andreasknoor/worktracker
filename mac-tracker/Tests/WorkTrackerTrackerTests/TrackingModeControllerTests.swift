import XCTest
@testable import WorkTrackerTracker

private final class FakeTrackingModeClient: TrackingModeAPIClient {
    var serverMode: TrackingMode = .auto
    var failure: Error?
    /// Runs while a request is "in flight".
    var onRequest: (() -> Void)?
    private(set) var setCalls: [TrackingMode] = []

    func getTrackingMode(serverBaseURL: String, apiKey: String) async throws -> TrackingMode {
        onRequest?()
        if let failure { throw failure }
        return serverMode
    }

    func setTrackingMode(_ mode: TrackingMode, serverBaseURL: String, apiKey: String) async throws -> TrackingMode {
        setCalls.append(mode)
        onRequest?()
        if let failure { throw failure }
        serverMode = mode
        return mode
    }
}

final class TrackingModeControllerTests: XCTestCase {
    private var clock = Date(timeIntervalSince1970: 1_000)
    private var client: FakeTrackingModeClient!
    private var controller: TrackingModeController!

    override func setUp() {
        super.setUp()
        client = FakeTrackingModeClient()
        controller = TrackingModeController(client: client, now: { [unowned self] in self.clock })
    }

    func test_modeIsUnknownUntilLoaded() async {
        XCTAssertNil(controller.currentMode)
        client.serverMode = .alwaysWork
        await controller.refresh(serverBaseURL: "https://x", apiKey: "k")
        XCTAssertEqual(controller.currentMode, .alwaysWork)
        XCTAssertNil(controller.lastError)
    }

    func test_failedRefresh_isSilentAndKeepsModeUnknown() async {
        client.failure = APIClientError.requestFailed(statusCode: 503)
        await controller.refresh(serverBaseURL: "https://x", apiKey: "k")
        XCTAssertNil(controller.currentMode)
        XCTAssertNil(controller.lastError)
    }

    func test_select_switchesAndClearsAnEarlierError() async {
        client.failure = URLError(.notConnectedToInternet)
        await controller.select(.alwaysLeisure, serverBaseURL: "https://x", apiKey: "k")
        XCTAssertEqual(controller.lastError, "Server unreachable")

        client.failure = nil
        await controller.select(.alwaysLeisure, serverBaseURL: "https://x", apiKey: "k")
        XCTAssertEqual(controller.currentMode, .alwaysLeisure)
        XCTAssertNil(controller.lastError)
        XCTAssertFalse(controller.isSwitching)
    }

    func test_failedSelect_keepsThePreviousModeAndIsNotQueued() async {
        await controller.refresh(serverBaseURL: "https://x", apiKey: "k")
        client.failure = APIClientError.requestFailed(statusCode: 500)
        await controller.select(.alwaysWork, serverBaseURL: "https://x", apiKey: "k")

        XCTAssertEqual(controller.currentMode, .auto)
        XCTAssertEqual(controller.lastError, "Server error (HTTP 500)")
        XCTAssertEqual(client.setCalls, [.alwaysWork])

        client.failure = nil
        await controller.refresh(serverBaseURL: "https://x", apiKey: "k")
        XCTAssertEqual(client.setCalls, [.alwaysWork], "a failed switch must not be retried later")
    }

    func test_errorMessages() {
        XCTAssertEqual(TrackingModeController.describe(APIClientError.unauthorized), "API key invalid or revoked")
        XCTAssertEqual(
            TrackingModeController.describe(APIClientError.requestFailed(statusCode: 404)),
            "Server doesn't support switching yet (update it)"
        )
    }

    func test_report_updatesTheMode() {
        controller.report(.alwaysWork, requestStartedAt: clock)
        XCTAssertEqual(controller.currentMode, .alwaysWork)
    }

    func test_report_fromARequestStartedBeforeTheLastSwitch_isIgnored() async {
        let flushStartedAt = clock
        clock = clock.addingTimeInterval(5)
        await controller.select(.alwaysLeisure, serverBaseURL: "https://x", apiKey: "k")

        // An event flush that started before the switch returns the old mode.
        controller.report(.auto, requestStartedAt: flushStartedAt)
        XCTAssertEqual(controller.currentMode, .alwaysLeisure)

        clock = clock.addingTimeInterval(5)
        controller.report(.alwaysWork, requestStartedAt: clock)
        XCTAssertEqual(controller.currentMode, .alwaysWork)
    }

    func test_report_whileSwitching_isIgnored() async {
        client.onRequest = { [unowned self] in
            self.controller.report(.alwaysWork, requestStartedAt: self.clock)
            XCTAssertTrue(self.controller.isSwitching)
        }
        await controller.select(.alwaysLeisure, serverBaseURL: "https://x", apiKey: "k")
        XCTAssertEqual(controller.currentMode, .alwaysLeisure)
    }

    func test_reset_forgetsTheMode() async {
        await controller.refresh(serverBaseURL: "https://x", apiKey: "k")
        controller.reset()
        XCTAssertNil(controller.currentMode)
    }
}

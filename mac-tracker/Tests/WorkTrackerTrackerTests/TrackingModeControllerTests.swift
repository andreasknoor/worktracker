import XCTest
@testable import WorkTrackerTracker

private final class FakeTrackingModeClient: TrackingModeAPIClient {
    var serverMode: TrackingMode = .auto
    var failure: Error?

    func getTrackingMode(serverBaseURL: String, apiKey: String) async throws -> TrackingMode {
        if let failure { throw failure }
        return serverMode
    }
}

final class TrackingModeControllerTests: XCTestCase {
    private var client: FakeTrackingModeClient!
    private var controller: TrackingModeController!

    override func setUp() {
        super.setUp()
        client = FakeTrackingModeClient()
        controller = TrackingModeController(client: client)
    }

    func test_modeIsUnknownUntilLoaded() async {
        XCTAssertNil(controller.currentMode)
        client.serverMode = .alwaysWork
        await controller.refresh(serverBaseURL: "https://x", apiKey: "k")
        XCTAssertEqual(controller.currentMode, .alwaysWork)
    }

    func test_failedRefresh_isSilentAndKeepsModeUnknown() async {
        client.failure = APIClientError.requestFailed(statusCode: 503)
        await controller.refresh(serverBaseURL: "https://x", apiKey: "k")
        XCTAssertNil(controller.currentMode)
    }

    func test_report_updatesTheMode() {
        controller.report(.alwaysWork)
        XCTAssertEqual(controller.currentMode, .alwaysWork)
    }

    func test_reset_forgetsTheMode() async {
        await controller.refresh(serverBaseURL: "https://x", apiKey: "k")
        controller.reset()
        XCTAssertNil(controller.currentMode)
    }
}

final class WorkTypeSettingTests: XCTestCase {
    func test_stampedWorkType() {
        XCTAssertEqual(WorkTypeSetting.work.stampedWorkType, .work)
        XCTAssertEqual(WorkTypeSetting.leisure.stampedWorkType, .leisure)
        XCTAssertNil(WorkTypeSetting.server.stampedWorkType)
    }

    func test_menuTitle_showsTheServerModeWhenKnown() {
        XCTAssertEqual(WorkTypeSetting.server.menuTitle(serverMode: .auto), "As defined on server (currently: Auto)")
        XCTAssertEqual(WorkTypeSetting.server.menuTitle(serverMode: nil), "As defined on server")
        XCTAssertEqual(WorkTypeSetting.leisure.menuTitle(serverMode: .alwaysWork), "Leisure")
    }
}

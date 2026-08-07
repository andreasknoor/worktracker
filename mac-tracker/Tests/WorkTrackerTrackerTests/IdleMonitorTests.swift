import XCTest
@testable import WorkTrackerTracker

final class IdleMonitorTests: XCTestCase {
    func test_recentInput_isTreatedAsActive() {
        XCTAssertTrue(shouldRecordActivity(secondsSinceLastInput: 5, pollInterval: 30))
    }

    func test_inputExactlyAtPollInterval_isNotActive() {
        // Boundary: input right at the poll interval is not "during" this
        // poll window (mirrors the calculator's "gap exactly equal to
        // threshold does not split" convention of using strict inequality).
        XCTAssertFalse(shouldRecordActivity(secondsSinceLastInput: 30, pollInterval: 30))
    }

    func test_noRecentInput_isNotActive() {
        XCTAssertFalse(shouldRecordActivity(secondsSinceLastInput: 300, pollInterval: 30))
    }

    func test_zeroSecondsSinceInput_isActive() {
        XCTAssertTrue(shouldRecordActivity(secondsSinceLastInput: 0, pollInterval: 30))
    }

    func test_start_callsOnActiveWhileInputIsRecent() {
        let source = FakeIdleTimeSource(secondsToReturn: 0) // always "just active"
        let expectation = expectation(description: "onActive fired")
        let monitor = IdleMonitor(idleTimeSource: source, pollInterval: 0.05) {
            expectation.fulfill()
        }

        monitor.start()
        defer { monitor.stop() }

        wait(for: [expectation], timeout: 2)
    }
}

private final class FakeIdleTimeSource: SystemIdleTimeSource {
    var secondsToReturn: TimeInterval
    init(secondsToReturn: TimeInterval) { self.secondsToReturn = secondsToReturn }
    func secondsSinceLastInput() -> TimeInterval { secondsToReturn }
}

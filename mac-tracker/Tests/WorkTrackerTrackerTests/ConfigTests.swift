import XCTest
@testable import WorkTrackerTracker

final class ConfigTests: XCTestCase {
    private var tempURL: URL!

    override func setUp() {
        super.setUp()
        tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("config.json")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempURL.deletingLastPathComponent())
        super.tearDown()
    }

    func test_load_withNothingSaved_returnsEmptyDefaults() {
        let config = ConfigStore.load(from: tempURL)

        XCTAssertEqual(config, .empty)
        XCTAssertFalse(config.isConfigured)
    }

    func test_save_thenLoad_roundTrips() throws {
        let saved = TrackerConfig(serverBaseURL: "https://worktracker.example.vercel.app", apiKey: "wtk_live_abc123", pollIntervalSeconds: 45)

        try ConfigStore.save(saved, to: tempURL)
        let loaded = ConfigStore.load(from: tempURL)

        XCTAssertEqual(loaded, saved)
    }

    func test_save_createsIntermediateDirectories() throws {
        try ConfigStore.save(.empty, to: tempURL)

        XCTAssertTrue(FileManager.default.fileExists(atPath: tempURL.path))
    }

    func test_isConfigured_requiresBothServerURLAndApiKey() {
        XCTAssertFalse(TrackerConfig(serverBaseURL: "", apiKey: "", pollIntervalSeconds: 30).isConfigured)
        XCTAssertFalse(TrackerConfig(serverBaseURL: "https://x.example", apiKey: "", pollIntervalSeconds: 30).isConfigured)
        XCTAssertFalse(TrackerConfig(serverBaseURL: "", apiKey: "wtk_live_x", pollIntervalSeconds: 30).isConfigured)
        XCTAssertTrue(TrackerConfig(serverBaseURL: "https://x.example", apiKey: "wtk_live_x", pollIntervalSeconds: 30).isConfigured)
    }
}

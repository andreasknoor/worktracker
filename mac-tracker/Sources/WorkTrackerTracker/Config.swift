import Foundation

/// Tracker configuration: which server to push activity events to, the
/// device's own API key (issued once via `POST /api/devices` on the
/// dashboard), and how often to poll for input activity. Mirrors the wire
/// protocol in API_CONTRACT.md, shared with the Windows tracker.
struct TrackerConfig: Codable, Equatable {
    var serverBaseURL: String
    var apiKey: String
    var pollIntervalSeconds: Int

    static let empty = TrackerConfig(serverBaseURL: "", apiKey: "", pollIntervalSeconds: 30)

    var isConfigured: Bool {
        !serverBaseURL.isEmpty && !apiKey.isEmpty
    }
}

/// Loads and saves `TrackerConfig` as JSON at an explicit file URL. The
/// production default location is `~/Library/Application Support/WorkTracker/config.json`
/// (see `ConfigStore.defaultConfigFileURL()`); tests point this at a temp file instead.
enum ConfigStore {
    static func defaultConfigFileURL() -> URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return appSupport.appendingPathComponent("WorkTracker", isDirectory: true).appendingPathComponent("config.json")
    }

    static func load(from url: URL) -> TrackerConfig {
        guard let data = try? Data(contentsOf: url) else { return .empty }
        guard let decoded = try? JSONDecoder().decode(TrackerConfig.self, from: data) else { return .empty }
        return decoded
    }

    static func save(_ config: TrackerConfig, to url: URL) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(config)
        try data.write(to: url, options: .atomic)
    }
}

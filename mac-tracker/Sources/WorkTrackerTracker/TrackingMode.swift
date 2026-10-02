import Foundation

/// The device's server-side work/leisure classification mode, set in the
/// dashboard — the same three values as the server's `trackingMode` (see
/// docs/API_CONTRACT.md). It only governs time captured while the tracker's
/// own `WorkTypeSetting` is `.server`.
enum TrackingMode: String, CaseIterable {
    case auto
    case alwaysWork
    case alwaysLeisure

    var menuTitle: String {
        switch self {
        case .auto: return "Auto"
        case .alwaysWork: return "Work"
        case .alwaysLeisure: return "Leisure"
        }
    }
}

/// The work type stamped on a captured event (`POST /api/events`'s
/// `workType`). Absent (`nil`) means "as defined on the server".
enum WorkType: String, Codable, Equatable {
    case work
    case leisure
}

/// What the tracker's menu is set to: classify captured time as work, as
/// leisure, or as defined on the server (the device's `TrackingMode`).
/// Applies to every event captured from then on, stamped onto the event
/// itself — so it works offline and is never applied retroactively.
enum WorkTypeSetting: String, Codable, CaseIterable {
    case work
    case leisure
    case server

    /// What gets stamped on events captured under this setting.
    var stampedWorkType: WorkType? {
        switch self {
        case .work: return .work
        case .leisure: return .leisure
        case .server: return nil
        }
    }

    /// The menu entry; `serverMode` is the device's mode as last reported,
    /// nil while unknown.
    func menuTitle(serverMode: TrackingMode?) -> String {
        switch self {
        case .work: return "Work"
        case .leisure: return "Leisure"
        case .server: return serverMode.map { "As defined on server (currently: \($0.menuTitle))" } ?? "As defined on server"
        }
    }
}

/// Reads this device's own server-side tracking mode via `GET
/// /api/tracker/mode`, authenticated with the device's API key. Abstracted
/// so `TrackingModeController` can be tested without a server.
protocol TrackingModeAPIClient {
    func getTrackingMode(serverBaseURL: String, apiKey: String) async throws -> TrackingMode
}

/// The tracker's view of the device's server-side tracking mode, shown under
/// "As defined on server" in the menu. Kept in sync two ways: an explicit
/// read at startup (`refresh`), and the mode the server reports back on
/// every accepted event batch (`report`) — which picks up changes made in
/// the dashboard without any extra polling. The tracker never changes this
/// mode itself; its own choice is the local `WorkTypeSetting`.
///
/// Thread-safety: methods may be called from any thread; state is guarded
/// by `lock`, which is never held across an `await`.
final class TrackingModeController {
    private let client: TrackingModeAPIClient
    private let lock = NSLock()

    private var mode: TrackingMode?

    init(client: TrackingModeAPIClient) {
        self.client = client
    }

    /// nil until the mode is known (not configured, or not yet reachable).
    var currentMode: TrackingMode? { lock.withLock { mode } }

    /// Forgets everything, e.g. after the server URL or API key changed.
    func reset() {
        lock.withLock { mode = nil }
    }

    func refresh(serverBaseURL: String, apiKey: String) async {
        do {
            let fetched = try await client.getTrackingMode(serverBaseURL: serverBaseURL, apiKey: apiKey)
            lock.withLock { mode = fetched }
        } catch {
            // Silent: the mode shows as unknown until a later report fills it in.
        }
    }

    /// The mode the server reported with an accepted event batch.
    func report(_ reported: TrackingMode) {
        lock.withLock { mode = reported }
    }
}

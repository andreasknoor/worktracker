import Foundation

/// The device's work/leisure classification mode — the same three values
/// as the server's `trackingMode` (see docs/API_CONTRACT.md). A switch
/// applies from the moment the server receives it; time already tracked
/// keeps the mode it was tracked under.
enum TrackingMode: String, CaseIterable {
    case auto
    case alwaysWork
    case alwaysLeisure

    var menuTitle: String {
        switch self {
        case .auto: return "Auto (weekdays work, weekends leisure)"
        case .alwaysWork: return "Work"
        case .alwaysLeisure: return "Leisure"
        }
    }
}

/// Reads and switches this device's own tracking mode via
/// `GET`/`PUT /api/tracker/mode`, authenticated with the device's API key.
/// Abstracted so `TrackingModeController` can be tested without a server.
protocol TrackingModeAPIClient {
    func getTrackingMode(serverBaseURL: String, apiKey: String) async throws -> TrackingMode
    func setTrackingMode(_ mode: TrackingMode, serverBaseURL: String, apiKey: String) async throws -> TrackingMode
}

/// The tracker's view of its tracking mode, kept in sync three ways: an
/// explicit read at startup (`refresh`), the user switching it from the menu
/// (`select`), and the mode the server reports back on every accepted event
/// batch (`report`) — which picks up changes made in the dashboard without
/// any extra polling.
///
/// Switches are not queued: if the server can't be reached, the switch
/// fails visibly and the previous mode stays checked. A switch only means
/// something at the moment it happens, so replaying it later would be wrong.
///
/// Thread-safety: methods may be called from any thread; state is guarded
/// by `lock`, which is never held across an `await`.
final class TrackingModeController {
    private let client: TrackingModeAPIClient
    private let now: () -> Date
    private let lock = NSLock()

    private var mode: TrackingMode?
    private var switching = false
    private var error: String?
    /// Responses to requests that started before the last completed switch
    /// carry the pre-switch mode and must not overwrite it.
    private var lastSwitchCompletedAt: Date?

    init(client: TrackingModeAPIClient, now: @escaping () -> Date = Date.init) {
        self.client = client
        self.now = now
    }

    /// nil until the mode is known (not configured, or not yet reachable).
    var currentMode: TrackingMode? { lock.withLock { mode } }
    var isSwitching: Bool { lock.withLock { switching } }
    /// Why the last switch failed, or nil.
    var lastError: String? { lock.withLock { error } }

    /// Forgets everything, e.g. after the server URL or API key changed.
    func reset() {
        lock.withLock {
            mode = nil
            switching = false
            error = nil
            lastSwitchCompletedAt = nil
        }
    }

    func refresh(serverBaseURL: String, apiKey: String) async {
        let startedAt = now()
        do {
            let fetched = try await client.getTrackingMode(serverBaseURL: serverBaseURL, apiKey: apiKey)
            accept(fetched, requestStartedAt: startedAt)
        } catch {
            // Silent: the mode shows as unknown until a later report fills it in.
        }
    }

    /// Switches the mode on the server. A no-op while another switch is in flight.
    func select(_ newMode: TrackingMode, serverBaseURL: String, apiKey: String) async {
        let started: Bool = lock.withLock {
            guard !switching else { return false }
            switching = true
            return true
        }
        guard started else { return }

        do {
            let confirmed = try await client.setTrackingMode(newMode, serverBaseURL: serverBaseURL, apiKey: apiKey)
            lock.withLock {
                mode = confirmed
                error = nil
                switching = false
                lastSwitchCompletedAt = now()
            }
        } catch {
            let message = Self.describe(error)
            lock.withLock {
                self.error = message
                switching = false
            }
        }
    }

    /// The mode the server reported for a request that started at `requestStartedAt`.
    func report(_ reported: TrackingMode, requestStartedAt: Date) {
        accept(reported, requestStartedAt: requestStartedAt)
    }

    private func accept(_ reported: TrackingMode, requestStartedAt: Date) {
        lock.withLock {
            guard !switching else { return }
            if let lastSwitchCompletedAt, requestStartedAt < lastSwitchCompletedAt { return }
            mode = reported
        }
    }

    static func describe(_ error: Error) -> String {
        switch error as? APIClientError {
        case .unauthorized: return "API key invalid or revoked"
        case .invalidServerURL: return "Invalid server URL"
        case .requestFailed(let status) where status == 404: return "Server doesn't support switching yet (update it)"
        case .requestFailed(let status) where status > 0: return "Server error (HTTP \(status))"
        default: return "Server unreachable"
        }
    }
}

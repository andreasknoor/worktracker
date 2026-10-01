import Foundation

enum APIClientError: Error {
    case invalidServerURL
    case unauthorized
    case requestFailed(statusCode: Int)

    /// The server understood the request and refuses this data (malformed
    /// or oversized batch). Retrying the identical payload can never
    /// succeed, unlike a 5xx, 429 or network error.
    var isPermanentRejection: Bool {
        if case .requestFailed(let status) = self { return [400, 413, 422].contains(status) }
        return false
    }
}

/// Pushes activity timestamps to the server. Abstracted so `ActivityQueue`
/// can be tested against a fake without making real network calls.
protocol EventsAPIClient {
    /// Posts a batch of timestamps to `POST {serverBaseURL}/api/events`,
    /// authenticated with the device's API key. See API_CONTRACT.md.
    func postEvents(_ timestamps: [Date], serverBaseURL: String, apiKey: String) async throws
}

private struct EventsBatchBody: Encodable {
    let timestamps: [String]
}

private struct TrackingModeBody: Codable {
    let trackingMode: String
}

final class URLSessionEventsAPIClient: EventsAPIClient, TrackingModeAPIClient {
    private let session: URLSession
    private let dateFormatter: ISO8601DateFormatter

    /// Called with the device's current tracking mode whenever an event
    /// batch is accepted (the server includes it in the response), along
    /// with when that request started — see `TrackingModeController.report`.
    /// May be called on any thread.
    var onTrackingModeReported: ((TrackingMode, Date) -> Void)?

    init(session: URLSession = .shared) {
        self.session = session
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        self.dateFormatter = formatter
    }

    func postEvents(_ timestamps: [Date], serverBaseURL: String, apiKey: String) async throws {
        let startedAt = Date()
        let body = try JSONEncoder().encode(
            EventsBatchBody(timestamps: timestamps.map { dateFormatter.string(from: $0) })
        )
        let data = try await send("POST", path: "api/events", body: body, serverBaseURL: serverBaseURL, apiKey: apiKey)

        // Servers before v1.24 answer with an empty body; that's fine.
        if let reported = try? JSONDecoder().decode(TrackingModeBody.self, from: data),
           let mode = TrackingMode(rawValue: reported.trackingMode) {
            onTrackingModeReported?(mode, startedAt)
        }
    }

    func getTrackingMode(serverBaseURL: String, apiKey: String) async throws -> TrackingMode {
        let data = try await send("GET", path: "api/tracker/mode", body: nil, serverBaseURL: serverBaseURL, apiKey: apiKey)
        return try Self.decodeMode(data)
    }

    func setTrackingMode(_ mode: TrackingMode, serverBaseURL: String, apiKey: String) async throws -> TrackingMode {
        let body = try JSONEncoder().encode(TrackingModeBody(trackingMode: mode.rawValue))
        let data = try await send("PUT", path: "api/tracker/mode", body: body, serverBaseURL: serverBaseURL, apiKey: apiKey)
        return try Self.decodeMode(data)
    }

    private static func decodeMode(_ data: Data) throws -> TrackingMode {
        guard let body = try? JSONDecoder().decode(TrackingModeBody.self, from: data),
              let mode = TrackingMode(rawValue: body.trackingMode) else {
            throw APIClientError.requestFailed(statusCode: -1)
        }
        return mode
    }

    private func send(_ method: String, path: String, body: Data?, serverBaseURL: String, apiKey: String) async throws -> Data {
        guard let base = URL(string: serverBaseURL) else {
            throw APIClientError.invalidServerURL
        }
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = TrackerConstants.requestTimeoutSeconds
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = body

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIClientError.requestFailed(statusCode: -1)
        }
        if http.statusCode == 401 {
            throw APIClientError.unauthorized
        }
        guard (200...299).contains(http.statusCode) else {
            throw APIClientError.requestFailed(statusCode: http.statusCode)
        }
        return data
    }
}

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
    /// authenticated with the device's API key. `workType` is what all of
    /// them were captured under; nil ("as defined on the server") is
    /// omitted from the request. See API_CONTRACT.md.
    func postEvents(_ timestamps: [Date], workType: WorkType?, serverBaseURL: String, apiKey: String) async throws
}

private struct EventsBatchBody: Encodable {
    let timestamps: [String]
    let workType: WorkType?
}

private struct EventsResponseBody: Decodable {
    let trackingMode: String?
    let acceptsWorkType: Bool?
}

private struct TrackingModeBody: Decodable {
    let trackingMode: String
}

final class URLSessionEventsAPIClient: EventsAPIClient, TrackingModeAPIClient {
    private let session: URLSession
    private let dateFormatter: ISO8601DateFormatter

    /// Called with the device's current tracking mode whenever an event
    /// batch is accepted (the server includes it in the response) — see
    /// `TrackingModeController.report`. May be called on any thread.
    var onTrackingModeReported: ((TrackingMode) -> Void)?

    /// Called after every accepted batch that carried a work type: true if
    /// the server stored it, false if it's a pre-v1.30 server that silently
    /// ignored it (no `acceptsWorkType` in the response). May be called on
    /// any thread.
    var onWorkTypeSupportReported: ((Bool) -> Void)?

    init(session: URLSession = .shared) {
        self.session = session
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        self.dateFormatter = formatter
    }

    func postEvents(_ timestamps: [Date], workType: WorkType?, serverBaseURL: String, apiKey: String) async throws {
        let body = try JSONEncoder().encode(
            EventsBatchBody(timestamps: timestamps.map { dateFormatter.string(from: $0) }, workType: workType)
        )
        let data = try await send("POST", path: "api/events", body: body, serverBaseURL: serverBaseURL, apiKey: apiKey)

        // Servers before v1.24 answer with an empty body; that's fine.
        let response = try? JSONDecoder().decode(EventsResponseBody.self, from: data)
        if let raw = response?.trackingMode, let mode = TrackingMode(rawValue: raw) {
            onTrackingModeReported?(mode)
        }
        if workType != nil {
            onWorkTypeSupportReported?(response?.acceptsWorkType == true)
        }
    }

    func getTrackingMode(serverBaseURL: String, apiKey: String) async throws -> TrackingMode {
        let data = try await send("GET", path: "api/tracker/mode", body: nil, serverBaseURL: serverBaseURL, apiKey: apiKey)
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

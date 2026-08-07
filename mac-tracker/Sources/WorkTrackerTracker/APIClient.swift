import Foundation

enum APIClientError: Error {
    case invalidServerURL
    case unauthorized
    case requestFailed(statusCode: Int)
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

final class URLSessionEventsAPIClient: EventsAPIClient {
    private let session: URLSession
    private let dateFormatter: ISO8601DateFormatter

    init(session: URLSession = .shared) {
        self.session = session
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        self.dateFormatter = formatter
    }

    func postEvents(_ timestamps: [Date], serverBaseURL: String, apiKey: String) async throws {
        guard let base = URL(string: serverBaseURL) else {
            throw APIClientError.invalidServerURL
        }
        let url = base.appendingPathComponent("api/events")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(
            EventsBatchBody(timestamps: timestamps.map { dateFormatter.string(from: $0) })
        )

        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIClientError.requestFailed(statusCode: -1)
        }
        if http.statusCode == 401 {
            throw APIClientError.unauthorized
        }
        guard (200...299).contains(http.statusCode) else {
            throw APIClientError.requestFailed(statusCode: http.statusCode)
        }
    }
}

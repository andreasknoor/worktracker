import XCTest
@testable import WorkTrackerTracker

/// Serves canned responses to `URLSession` requests, recording each request.
private final class StubURLProtocol: URLProtocol {
    static var responses: [(status: Int, body: String)] = []
    static var requests: [URLRequest] = []
    static var bodies: [Data] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requests.append(request)
        if let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            stream.close()
            Self.bodies.append(data)
        } else {
            Self.bodies.append(request.httpBody ?? Data())
        }
        let (status, body) = Self.responses.isEmpty ? (500, "") : Self.responses.removeFirst()
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class APIClientTests: XCTestCase {
    private var client: URLSessionEventsAPIClient!

    override func setUp() {
        super.setUp()
        StubURLProtocol.responses = []
        StubURLProtocol.requests = []
        StubURLProtocol.bodies = []
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        client = URLSessionEventsAPIClient(session: URLSession(configuration: configuration))
    }

    func test_postEvents_reportsTheModeFromTheResponse() async throws {
        StubURLProtocol.responses = [(201, #"{"trackingMode":"alwaysLeisure","acceptsWorkType":true}"#)]
        var reported: TrackingMode?
        client.onTrackingModeReported = { reported = $0 }

        try await client.postEvents([Date()], workType: nil, serverBaseURL: "https://example.test", apiKey: "k")
        XCTAssertEqual(reported, .alwaysLeisure)
    }

    func test_postEvents_acceptsAnOlderServersEmptyBody() async throws {
        StubURLProtocol.responses = [(201, "")]
        var reported: TrackingMode?
        client.onTrackingModeReported = { reported = $0 }

        try await client.postEvents([Date()], workType: nil, serverBaseURL: "https://example.test", apiKey: "k")
        XCTAssertNil(reported)
    }

    func test_postEvents_omitsANilWorkType_andDoesNotReportSupport() async throws {
        StubURLProtocol.responses = [(201, #"{"trackingMode":"auto"}"#)]
        var supportReports: [Bool] = []
        client.onWorkTypeSupportReported = { supportReports.append($0) }

        try await client.postEvents([Date()], workType: nil, serverBaseURL: "https://example.test", apiKey: "k")

        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: StubURLProtocol.bodies[0]) as? [String: Any])
        XCTAssertNil(body["workType"])
        XCTAssertEqual(supportReports, [])
    }

    func test_postEvents_sendsTheWorkType_andReportsWhetherTheServerStoredIt() async throws {
        StubURLProtocol.responses = [
            (201, #"{"trackingMode":"auto","acceptsWorkType":true}"#),
            (201, #"{"trackingMode":"auto"}"#),
        ]
        var supportReports: [Bool] = []
        client.onWorkTypeSupportReported = { supportReports.append($0) }

        try await client.postEvents([Date()], workType: .leisure, serverBaseURL: "https://example.test", apiKey: "k")
        try await client.postEvents([Date()], workType: .work, serverBaseURL: "https://example.test", apiKey: "k")

        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: StubURLProtocol.bodies[0]) as? [String: Any])
        XCTAssertEqual(body["workType"] as? String, "leisure")
        XCTAssertEqual(supportReports, [true, false], "a pre-v1.30 server omits acceptsWorkType")
    }

    func test_getTrackingMode_readsTheModeWithTheDeviceKey() async throws {
        StubURLProtocol.responses = [(200, #"{"trackingMode":"alwaysWork","effectiveFrom":"2026-10-01T10:00:00.000Z"}"#)]

        let mode = try await client.getTrackingMode(serverBaseURL: "https://example.test", apiKey: "secret")

        XCTAssertEqual(mode, .alwaysWork)
        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.absoluteString, "https://example.test/api/tracker/mode")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
    }

    func test_getTrackingMode_mapsUnauthorized() async {
        StubURLProtocol.responses = [(401, "")]
        do {
            _ = try await client.getTrackingMode(serverBaseURL: "https://example.test", apiKey: "k")
            XCTFail("expected unauthorized")
        } catch {
            guard case APIClientError.unauthorized = error else { return XCTFail("unexpected \(error)") }
        }
    }
}

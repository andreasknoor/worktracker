using System.Net;
using System.Text;
using WorkTrackerTracker.Core;

namespace WorkTrackerTracker.Core.Tests;

internal sealed class FakeTrackingModeApiClient : ITrackingModeApiClient
{
    public TrackingMode ServerMode { get; set; } = TrackingMode.Auto;
    public Exception? Failure { get; set; }

    public Task<TrackingMode> GetTrackingModeAsync(string serverBaseUrl, string apiKey, CancellationToken cancellationToken = default)
    {
        if (Failure is not null) throw Failure;
        return Task.FromResult(ServerMode);
    }
}

/// <summary>Serves canned responses, recording each request and its body.</summary>
internal sealed class StubHandler : HttpMessageHandler
{
    public Queue<(HttpStatusCode Status, string Body)> Responses { get; } = new();
    public List<(HttpRequestMessage Request, string Body)> Requests { get; } = new();

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken);
        Requests.Add((request, body));
        var (status, responseBody) = Responses.Count > 0 ? Responses.Dequeue() : (HttpStatusCode.InternalServerError, string.Empty);
        return new HttpResponseMessage(status) { Content = new StringContent(responseBody, Encoding.UTF8, "application/json") };
    }
}

public sealed class TrackingModeControllerTests
{
    private readonly FakeTrackingModeApiClient _client = new();
    private readonly TrackingModeController _controller;

    public TrackingModeControllerTests()
    {
        _controller = new TrackingModeController(_client);
    }

    [Fact]
    public async Task Mode_IsUnknownUntilLoaded()
    {
        Assert.Null(_controller.CurrentMode);
        _client.ServerMode = TrackingMode.AlwaysWork;
        await _controller.RefreshAsync("https://x", "k");
        Assert.Equal(TrackingMode.AlwaysWork, _controller.CurrentMode);
    }

    [Fact]
    public async Task FailedRefresh_IsSilent()
    {
        _client.Failure = new HttpRequestException("offline");
        await _controller.RefreshAsync("https://x", "k");
        Assert.Null(_controller.CurrentMode);
    }

    [Fact]
    public void Report_UpdatesTheMode()
    {
        _controller.Report(TrackingMode.AlwaysWork);
        Assert.Equal(TrackingMode.AlwaysWork, _controller.CurrentMode);
    }

    [Fact]
    public async Task Reset_ForgetsTheMode()
    {
        await _controller.RefreshAsync("https://x", "k");
        _controller.Reset();
        Assert.Null(_controller.CurrentMode);
    }
}

public sealed class WorkTypeSettingTests
{
    [Fact]
    public void Stamped()
    {
        Assert.Equal(WorkType.Work, WorkTypes.Stamped(WorkTypeSetting.Work));
        Assert.Equal(WorkType.Leisure, WorkTypes.Stamped(WorkTypeSetting.Leisure));
        Assert.Null(WorkTypes.Stamped(WorkTypeSetting.Server));
    }

    [Fact]
    public void MenuTitle_ShowsTheServerModeWhenKnown()
    {
        Assert.Equal("As defined on server (currently: Auto)", WorkTypes.MenuTitle(WorkTypeSetting.Server, TrackingMode.Auto));
        Assert.Equal("As defined on server", WorkTypes.MenuTitle(WorkTypeSetting.Server, null));
        Assert.Equal("Leisure", WorkTypes.MenuTitle(WorkTypeSetting.Leisure, TrackingMode.AlwaysWork));
    }
}

public sealed class HttpTrackingModeTests
{
    private readonly StubHandler _handler = new();
    private readonly HttpEventsApiClient _client;

    public HttpTrackingModeTests()
    {
        _client = new HttpEventsApiClient(new HttpClient(_handler));
    }

    [Fact]
    public async Task PostEvents_ReportsTheModeFromTheResponse()
    {
        _handler.Responses.Enqueue((HttpStatusCode.Created, """{"trackingMode":"alwaysLeisure","acceptsWorkType":true}"""));
        TrackingMode? reported = null;
        _client.TrackingModeReported = mode => reported = mode;

        await _client.PostEventsAsync(new[] { DateTimeOffset.UtcNow }, null, "https://example.test", "k");
        Assert.Equal(TrackingMode.AlwaysLeisure, reported);
    }

    [Fact]
    public async Task PostEvents_AcceptsAnOlderServersEmptyBody()
    {
        _handler.Responses.Enqueue((HttpStatusCode.Created, ""));
        TrackingMode? reported = null;
        _client.TrackingModeReported = mode => reported = mode;

        await _client.PostEventsAsync(new[] { DateTimeOffset.UtcNow }, null, "https://example.test", "k");
        Assert.Null(reported);
    }

    [Fact]
    public async Task PostEvents_OmitsANullWorkType_AndDoesNotReportSupport()
    {
        _handler.Responses.Enqueue((HttpStatusCode.Created, """{"trackingMode":"auto"}"""));
        var supportReports = new List<bool>();
        _client.WorkTypeSupportReported = supportReports.Add;

        await _client.PostEventsAsync(new[] { DateTimeOffset.UtcNow }, null, "https://example.test", "k");

        Assert.DoesNotContain("workType", _handler.Requests[0].Body);
        Assert.Empty(supportReports);
    }

    [Fact]
    public async Task PostEvents_SendsTheWorkType_AndReportsWhetherTheServerStoredIt()
    {
        _handler.Responses.Enqueue((HttpStatusCode.Created, """{"trackingMode":"auto","acceptsWorkType":true}"""));
        _handler.Responses.Enqueue((HttpStatusCode.Created, """{"trackingMode":"auto"}"""));
        var supportReports = new List<bool>();
        _client.WorkTypeSupportReported = supportReports.Add;

        await _client.PostEventsAsync(new[] { DateTimeOffset.UtcNow }, WorkType.Leisure, "https://example.test", "k");
        await _client.PostEventsAsync(new[] { DateTimeOffset.UtcNow }, WorkType.Work, "https://example.test", "k");

        Assert.Contains("\"workType\":\"leisure\"", _handler.Requests[0].Body);
        Assert.Equal(new[] { true, false }, supportReports); // a pre-v1.30 server omits acceptsWorkType
    }

    [Fact]
    public async Task GetTrackingMode_ReadsTheModeWithTheDeviceKey()
    {
        _handler.Responses.Enqueue((HttpStatusCode.OK, """{"trackingMode":"alwaysWork","effectiveFrom":"2026-10-01T10:00:00.000Z"}"""));

        var mode = await _client.GetTrackingModeAsync("https://example.test/", "secret");

        Assert.Equal(TrackingMode.AlwaysWork, mode);
        var (request, _) = Assert.Single(_handler.Requests);
        Assert.Equal(HttpMethod.Get, request.Method);
        Assert.Equal("https://example.test/api/tracker/mode", request.RequestUri!.ToString());
        Assert.Equal("Bearer secret", request.Headers.Authorization!.ToString());
    }

    [Fact]
    public async Task GetTrackingMode_MapsStatusCodesToErrors()
    {
        _handler.Responses.Enqueue((HttpStatusCode.Unauthorized, ""));
        _handler.Responses.Enqueue((HttpStatusCode.NotFound, ""));

        var unauthorized = await Assert.ThrowsAsync<ApiClientException>(() => _client.GetTrackingModeAsync("https://example.test", "k"));
        Assert.True(unauthorized.IsUnauthorized);
        var notFound = await Assert.ThrowsAsync<ApiClientException>(() => _client.GetTrackingModeAsync("https://example.test", "k"));
        Assert.Equal(404, notFound.StatusCode);
    }

    [Theory]
    [InlineData("auto", TrackingMode.Auto)]
    [InlineData("alwaysWork", TrackingMode.AlwaysWork)]
    [InlineData("alwaysLeisure", TrackingMode.AlwaysLeisure)]
    public void WireValues_RoundTrip(string wire, TrackingMode mode)
    {
        Assert.Equal(wire, TrackingModes.ToWire(mode));
        Assert.True(TrackingModes.TryParse(wire, out var parsed));
        Assert.Equal(mode, parsed);
    }

    [Fact]
    public void UnknownWireValue_IsRejected()
    {
        Assert.False(TrackingModes.TryParse("sometimes", out _));
        Assert.False(TrackingModes.TryParse(null, out _));
    }
}

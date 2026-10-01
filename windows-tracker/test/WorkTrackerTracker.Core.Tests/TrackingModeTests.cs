using System.Net;
using System.Text;
using WorkTrackerTracker.Core;

namespace WorkTrackerTracker.Core.Tests;

internal sealed class FakeTrackingModeApiClient : ITrackingModeApiClient
{
    public TrackingMode ServerMode { get; set; } = TrackingMode.Auto;
    public Exception? Failure { get; set; }
    /// <summary>Runs while a request is "in flight".</summary>
    public Action? OnRequest { get; set; }
    public List<TrackingMode> SetCalls { get; } = new();

    public Task<TrackingMode> GetTrackingModeAsync(string serverBaseUrl, string apiKey, CancellationToken cancellationToken = default)
    {
        OnRequest?.Invoke();
        if (Failure is not null) throw Failure;
        return Task.FromResult(ServerMode);
    }

    public Task<TrackingMode> SetTrackingModeAsync(TrackingMode mode, string serverBaseUrl, string apiKey, CancellationToken cancellationToken = default)
    {
        SetCalls.Add(mode);
        OnRequest?.Invoke();
        if (Failure is not null) throw Failure;
        ServerMode = mode;
        return Task.FromResult(mode);
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
    private DateTimeOffset _clock = new(2026, 10, 1, 10, 0, 0, TimeSpan.Zero);
    private readonly FakeTrackingModeApiClient _client = new();
    private readonly TrackingModeController _controller;

    public TrackingModeControllerTests()
    {
        _controller = new TrackingModeController(_client, () => _clock);
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
        Assert.Null(_controller.LastError);
    }

    [Fact]
    public async Task Select_SwitchesAndClearsAnEarlierError()
    {
        _client.Failure = new HttpRequestException("offline");
        await _controller.SelectAsync(TrackingMode.AlwaysLeisure, "https://x", "k");
        Assert.Equal("Server unreachable", _controller.LastError);

        _client.Failure = null;
        await _controller.SelectAsync(TrackingMode.AlwaysLeisure, "https://x", "k");
        Assert.Equal(TrackingMode.AlwaysLeisure, _controller.CurrentMode);
        Assert.Null(_controller.LastError);
        Assert.False(_controller.IsSwitching);
    }

    [Fact]
    public async Task FailedSelect_KeepsThePreviousModeAndIsNotRetried()
    {
        await _controller.RefreshAsync("https://x", "k");
        _client.Failure = new ApiClientException("boom", 500);
        await _controller.SelectAsync(TrackingMode.AlwaysWork, "https://x", "k");

        Assert.Equal(TrackingMode.Auto, _controller.CurrentMode);
        Assert.Equal("Server error (HTTP 500)", _controller.LastError);

        _client.Failure = null;
        await _controller.RefreshAsync("https://x", "k");
        Assert.Equal(new[] { TrackingMode.AlwaysWork }, _client.SetCalls);
    }

    [Fact]
    public void Describe_MapsErrors()
    {
        Assert.Equal("API key invalid or revoked", TrackingModeController.Describe(new ApiClientException("x", 401)));
        Assert.Equal("Server doesn't support switching yet (update it)", TrackingModeController.Describe(new ApiClientException("x", 404)));
        Assert.Equal("Server unreachable", TrackingModeController.Describe(new TaskCanceledException()));
    }

    [Fact]
    public async Task Report_FromARequestStartedBeforeTheLastSwitch_IsIgnored()
    {
        var flushStartedAt = _clock;
        _clock = _clock.AddSeconds(5);
        await _controller.SelectAsync(TrackingMode.AlwaysLeisure, "https://x", "k");

        _controller.Report(TrackingMode.Auto, flushStartedAt);
        Assert.Equal(TrackingMode.AlwaysLeisure, _controller.CurrentMode);

        _clock = _clock.AddSeconds(5);
        _controller.Report(TrackingMode.AlwaysWork, _clock);
        Assert.Equal(TrackingMode.AlwaysWork, _controller.CurrentMode);
    }

    [Fact]
    public async Task Report_WhileSwitching_IsIgnored_AndASecondSelectIsANoOp()
    {
        _client.OnRequest = () =>
        {
            _controller.Report(TrackingMode.AlwaysWork, _clock);
            Assert.True(_controller.IsSwitching);
            _client.OnRequest = null;
            _ = _controller.SelectAsync(TrackingMode.Auto, "https://x", "k"); // ignored: a switch is in flight
        };
        await _controller.SelectAsync(TrackingMode.AlwaysLeisure, "https://x", "k");

        Assert.Equal(TrackingMode.AlwaysLeisure, _controller.CurrentMode);
        Assert.Equal(new[] { TrackingMode.AlwaysLeisure }, _client.SetCalls);
    }

    [Fact]
    public async Task Reset_ForgetsTheMode()
    {
        await _controller.RefreshAsync("https://x", "k");
        _controller.Reset();
        Assert.Null(_controller.CurrentMode);
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
        _handler.Responses.Enqueue((HttpStatusCode.Created, """{"trackingMode":"alwaysLeisure"}"""));
        TrackingMode? reported = null;
        _client.TrackingModeReported = (mode, _) => reported = mode;

        await _client.PostEventsAsync(new[] { DateTimeOffset.UtcNow }, "https://example.test", "k");
        Assert.Equal(TrackingMode.AlwaysLeisure, reported);
    }

    [Fact]
    public async Task PostEvents_AcceptsAnOlderServersEmptyBody()
    {
        _handler.Responses.Enqueue((HttpStatusCode.Created, ""));
        TrackingMode? reported = null;
        _client.TrackingModeReported = (mode, _) => reported = mode;

        await _client.PostEventsAsync(new[] { DateTimeOffset.UtcNow }, "https://example.test", "k");
        Assert.Null(reported);
    }

    [Fact]
    public async Task SetTrackingMode_PutsTheModeWithTheDeviceKey()
    {
        _handler.Responses.Enqueue((HttpStatusCode.OK, """{"trackingMode":"alwaysWork","effectiveFrom":"2026-10-01T10:00:00.000Z"}"""));

        var confirmed = await _client.SetTrackingModeAsync(TrackingMode.AlwaysWork, "https://example.test/", "secret");

        Assert.Equal(TrackingMode.AlwaysWork, confirmed);
        var (request, body) = Assert.Single(_handler.Requests);
        Assert.Equal(HttpMethod.Put, request.Method);
        Assert.Equal("https://example.test/api/tracker/mode", request.RequestUri!.ToString());
        Assert.Equal("Bearer secret", request.Headers.Authorization!.ToString());
        Assert.Equal("""{"trackingMode":"alwaysWork"}""", body);
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

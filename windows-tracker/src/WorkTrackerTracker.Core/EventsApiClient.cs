using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace WorkTrackerTracker.Core;

public sealed class ApiClientException : Exception
{
    public ApiClientException(string message, int? statusCode = null) : base(message)
    {
        StatusCode = statusCode;
    }

    /// <summary>HTTP status, or null when the request never got a response.</summary>
    public int? StatusCode { get; }

    public bool IsUnauthorized => StatusCode == 401;

    /// <summary>
    /// The server understood the request and refuses this data (malformed or
    /// oversized batch). Retrying the identical payload can never succeed,
    /// unlike a 5xx, 429 or network error.
    /// </summary>
    public bool IsPermanentRejection => StatusCode is 400 or 413 or 422;
}

/// <summary>
/// Pushes activity timestamps to the server. Abstracted so
/// <see cref="ActivityQueue"/> can be tested against a fake without making
/// real network calls.
/// </summary>
public interface IEventsApiClient
{
    /// <summary>
    /// Posts a batch of timestamps to POST {serverBaseUrl}/api/events,
    /// authenticated with the device's API key. See docs/API_CONTRACT.md.
    /// </summary>
    Task PostEventsAsync(IReadOnlyList<DateTimeOffset> timestamps, string serverBaseUrl, string apiKey, CancellationToken cancellationToken = default);
}

public sealed class HttpEventsApiClient : IEventsApiClient, ITrackingModeApiClient
{
    private readonly HttpClient _httpClient;
    private readonly Func<DateTimeOffset> _now;

    public HttpEventsApiClient(HttpClient? httpClient = null, Func<DateTimeOffset>? now = null)
    {
        _httpClient = httpClient ?? new HttpClient { Timeout = TrackerConstants.RequestTimeout };
        _now = now ?? (() => DateTimeOffset.UtcNow);
    }

    /// <summary>
    /// Called with the device's current tracking mode whenever an event batch
    /// is accepted (the server includes it in the response), along with when
    /// that request started — see <see cref="TrackingModeController.Report"/>.
    /// May be called on a thread-pool thread.
    /// </summary>
    public Action<TrackingMode, DateTimeOffset>? TrackingModeReported { get; set; }

    public async Task PostEventsAsync(IReadOnlyList<DateTimeOffset> timestamps, string serverBaseUrl, string apiKey, CancellationToken cancellationToken = default)
    {
        var startedAt = _now();
        var body = JsonContent.Create(new EventsBatchBody(timestamps.Select(FormatIso8601).ToArray()));
        var json = await SendAsync(HttpMethod.Post, "/api/events", body, serverBaseUrl, apiKey, cancellationToken).ConfigureAwait(false);

        // Servers before v1.24 answer with an empty body; that's fine.
        if (TryReadMode(json, out var mode))
        {
            TrackingModeReported?.Invoke(mode, startedAt);
        }
    }

    public async Task<TrackingMode> GetTrackingModeAsync(string serverBaseUrl, string apiKey, CancellationToken cancellationToken = default)
    {
        var json = await SendAsync(HttpMethod.Get, "/api/tracker/mode", null, serverBaseUrl, apiKey, cancellationToken).ConfigureAwait(false);
        return ReadMode(json);
    }

    public async Task<TrackingMode> SetTrackingModeAsync(TrackingMode mode, string serverBaseUrl, string apiKey, CancellationToken cancellationToken = default)
    {
        var body = JsonContent.Create(new TrackingModeBody(TrackingModes.ToWire(mode)));
        var json = await SendAsync(HttpMethod.Put, "/api/tracker/mode", body, serverBaseUrl, apiKey, cancellationToken).ConfigureAwait(false);
        return ReadMode(json);
    }

    private async Task<string> SendAsync(HttpMethod method, string path, HttpContent? content, string serverBaseUrl, string apiKey, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(method, serverBaseUrl.TrimEnd('/') + path) { Content = content };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);

        using var response = await _httpClient.SendAsync(request, cancellationToken).ConfigureAwait(false);

        if (response.StatusCode == HttpStatusCode.Unauthorized)
        {
            throw new ApiClientException("Invalid or revoked API key", 401);
        }
        if (!response.IsSuccessStatusCode)
        {
            throw new ApiClientException($"Request failed with status {(int)response.StatusCode}", (int)response.StatusCode);
        }
        return await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
    }

    private static TrackingMode ReadMode(string json) =>
        TryReadMode(json, out var mode) ? mode : throw new ApiClientException("Unexpected tracking-mode response");

    private static bool TryReadMode(string json, out TrackingMode mode)
    {
        mode = default;
        if (string.IsNullOrWhiteSpace(json)) return false;
        try
        {
            var body = JsonSerializer.Deserialize<TrackingModeBody>(json);
            return TrackingModes.TryParse(body?.TrackingMode, out mode);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static string FormatIso8601(DateTimeOffset timestamp) =>
        timestamp.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");

    private sealed record EventsBatchBody([property: JsonPropertyName("timestamps")] string[] Timestamps);

    private sealed record TrackingModeBody([property: JsonPropertyName("trackingMode")] string? TrackingMode);
}

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
    /// authenticated with the device's API key. <paramref name="workType"/>
    /// is what all of them were captured under; null ("as defined on the
    /// server") is omitted from the request. See docs/API_CONTRACT.md.
    /// </summary>
    Task PostEventsAsync(IReadOnlyList<DateTimeOffset> timestamps, WorkType? workType, string serverBaseUrl, string apiKey, CancellationToken cancellationToken = default);
}

public sealed class HttpEventsApiClient : IEventsApiClient, ITrackingModeApiClient
{
    private readonly HttpClient _httpClient;

    public HttpEventsApiClient(HttpClient? httpClient = null)
    {
        _httpClient = httpClient ?? new HttpClient { Timeout = TrackerConstants.RequestTimeout };
    }

    /// <summary>
    /// Called with the device's current tracking mode whenever an event batch
    /// is accepted (the server includes it in the response) — see
    /// <see cref="TrackingModeController.Report"/>. May be called on a
    /// thread-pool thread.
    /// </summary>
    public Action<TrackingMode>? TrackingModeReported { get; set; }

    /// <summary>
    /// Called after every accepted batch that carried a work type: true if
    /// the server stored it, false if it's a pre-v1.30 server that silently
    /// ignored it (no <c>acceptsWorkType</c> in the response). May be called
    /// on a thread-pool thread.
    /// </summary>
    public Action<bool>? WorkTypeSupportReported { get; set; }

    public async Task PostEventsAsync(IReadOnlyList<DateTimeOffset> timestamps, WorkType? workType, string serverBaseUrl, string apiKey, CancellationToken cancellationToken = default)
    {
        var body = JsonContent.Create(new EventsBatchBody(
            timestamps.Select(FormatIso8601).ToArray(),
            workType is { } w ? WorkTypes.ToWire(w) : null));
        var json = await SendAsync(HttpMethod.Post, "/api/events", body, serverBaseUrl, apiKey, cancellationToken).ConfigureAwait(false);

        // Servers before v1.24 answer with an empty body; that's fine.
        var response = TryDeserialize<EventsResponseBody>(json);
        if (TrackingModes.TryParse(response?.TrackingMode, out var mode))
        {
            TrackingModeReported?.Invoke(mode);
        }
        if (workType is not null)
        {
            WorkTypeSupportReported?.Invoke(response?.AcceptsWorkType == true);
        }
    }

    public async Task<TrackingMode> GetTrackingModeAsync(string serverBaseUrl, string apiKey, CancellationToken cancellationToken = default)
    {
        var json = await SendAsync(HttpMethod.Get, "/api/tracker/mode", null, serverBaseUrl, apiKey, cancellationToken).ConfigureAwait(false);
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
        TrackingModes.TryParse(TryDeserialize<TrackingModeBody>(json)?.TrackingMode, out var mode)
            ? mode
            : throw new ApiClientException("Unexpected tracking-mode response");

    private static T? TryDeserialize<T>(string json) where T : class
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            return JsonSerializer.Deserialize<T>(json);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string FormatIso8601(DateTimeOffset timestamp) =>
        timestamp.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");

    private sealed record EventsBatchBody(
        [property: JsonPropertyName("timestamps")] string[] Timestamps,
        [property: JsonPropertyName("workType"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? WorkType);

    private sealed record EventsResponseBody(
        [property: JsonPropertyName("trackingMode")] string? TrackingMode,
        [property: JsonPropertyName("acceptsWorkType")] bool? AcceptsWorkType);

    private sealed record TrackingModeBody([property: JsonPropertyName("trackingMode")] string? TrackingMode);
}

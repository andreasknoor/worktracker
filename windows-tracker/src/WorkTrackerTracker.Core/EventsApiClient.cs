using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
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

public sealed class HttpEventsApiClient : IEventsApiClient
{
    private readonly HttpClient _httpClient;

    public HttpEventsApiClient(HttpClient? httpClient = null)
    {
        _httpClient = httpClient ?? new HttpClient { Timeout = TrackerConstants.RequestTimeout };
    }

    public async Task PostEventsAsync(IReadOnlyList<DateTimeOffset> timestamps, string serverBaseUrl, string apiKey, CancellationToken cancellationToken = default)
    {
        var url = serverBaseUrl.TrimEnd('/') + "/api/events";

        using var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = JsonContent.Create(new EventsBatchBody(timestamps.Select(FormatIso8601).ToArray())),
        };
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
    }

    private static string FormatIso8601(DateTimeOffset timestamp) =>
        timestamp.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");

    private sealed record EventsBatchBody([property: JsonPropertyName("timestamps")] string[] Timestamps);
}

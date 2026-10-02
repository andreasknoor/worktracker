namespace WorkTrackerTracker.Core;

/// <summary>
/// The device's work/leisure classification mode, mirroring the server's
/// <c>trackingMode</c> values (see docs/API_CONTRACT.md). A switch applies
/// from the moment the server receives it; time already tracked keeps the
/// mode it was tracked under. Kept in sync with the Mac tracker's
/// TrackingMode.swift.
/// </summary>
public enum TrackingMode
{
    Auto,
    AlwaysWork,
    AlwaysLeisure,
}

public static class TrackingModes
{
    public static IReadOnlyList<TrackingMode> All { get; } = [TrackingMode.Auto, TrackingMode.AlwaysWork, TrackingMode.AlwaysLeisure];

    /// <summary>The server's wire value, e.g. "alwaysWork".</summary>
    public static string ToWire(TrackingMode mode) => mode switch
    {
        TrackingMode.Auto => "auto",
        TrackingMode.AlwaysWork => "alwaysWork",
        TrackingMode.AlwaysLeisure => "alwaysLeisure",
        _ => throw new ArgumentOutOfRangeException(nameof(mode)),
    };

    /// <summary>Parses a wire value; unknown values (e.g. from a newer server) yield false.</summary>
    public static bool TryParse(string? wire, out TrackingMode mode)
    {
        foreach (var candidate in All)
        {
            if (ToWire(candidate) == wire)
            {
                mode = candidate;
                return true;
            }
        }
        mode = default;
        return false;
    }

    public static string MenuTitle(TrackingMode mode) => mode switch
    {
        TrackingMode.Auto => "Auto (weekdays work, weekends leisure)",
        TrackingMode.AlwaysWork => "Work",
        TrackingMode.AlwaysLeisure => "Leisure",
        _ => throw new ArgumentOutOfRangeException(nameof(mode)),
    };
}

/// <summary>
/// Reads and switches this device's own tracking mode via GET/PUT
/// /api/tracker/mode, authenticated with the device's API key. Abstracted so
/// <see cref="TrackingModeController"/> can be tested without a server.
/// </summary>
public interface ITrackingModeApiClient
{
    Task<TrackingMode> GetTrackingModeAsync(string serverBaseUrl, string apiKey, CancellationToken cancellationToken = default);
    Task<TrackingMode> SetTrackingModeAsync(TrackingMode mode, string serverBaseUrl, string apiKey, CancellationToken cancellationToken = default);
}

/// <summary>
/// The tracker's view of its tracking mode, kept in sync three ways: an
/// explicit read at startup (<see cref="RefreshAsync"/>), the user switching
/// it from the tray menu (<see cref="SelectAsync"/>), and the mode the server
/// reports back on every accepted event batch (<see cref="Report"/>) — which
/// picks up changes made in the dashboard without any extra polling.
/// </summary>
/// <remarks>
/// Switches are not queued: if the server can't be reached, the switch fails
/// visibly and the previous mode stays checked — a switch only means
/// something at the moment it happens. Thread-safe; the lock is never held
/// across an await. Kept in sync with the Mac tracker's TrackingModeController.
/// </remarks>
public sealed class TrackingModeController
{
    private readonly ITrackingModeApiClient _client;
    private readonly Func<DateTimeOffset> _now;
    private readonly object _lock = new();

    private TrackingMode? _mode;
    private bool _isSwitching;
    private string? _lastError;
    // Responses to requests that started before the last completed switch
    // carry the pre-switch mode and must not overwrite it.
    private DateTimeOffset? _lastSwitchCompletedAt;

    public TrackingModeController(ITrackingModeApiClient client, Func<DateTimeOffset>? now = null)
    {
        _client = client;
        _now = now ?? (() => DateTimeOffset.UtcNow);
    }

    /// <summary>Null until the mode is known (not configured, or not yet reachable).</summary>
    public TrackingMode? CurrentMode { get { lock (_lock) { return _mode; } } }

    public bool IsSwitching { get { lock (_lock) { return _isSwitching; } } }

    /// <summary>Why the last switch failed, or null.</summary>
    public string? LastError { get { lock (_lock) { return _lastError; } } }

    /// <summary>Forgets everything, e.g. after the server URL or API key changed.</summary>
    public void Reset()
    {
        lock (_lock)
        {
            _mode = null;
            _isSwitching = false;
            _lastError = null;
            _lastSwitchCompletedAt = null;
        }
    }

    public async Task RefreshAsync(string serverBaseUrl, string apiKey)
    {
        var startedAt = _now();
        try
        {
            var fetched = await _client.GetTrackingModeAsync(serverBaseUrl, apiKey).ConfigureAwait(false);
            Accept(fetched, startedAt);
        }
        catch (Exception ex) when (ex is ApiClientException or HttpRequestException or TaskCanceledException)
        {
            // Silent: the mode shows as unknown until a later report fills it in.
        }
    }

    /// <summary>Switches the mode on the server. A no-op while another switch is in flight.</summary>
    public async Task SelectAsync(TrackingMode mode, string serverBaseUrl, string apiKey)
    {
        lock (_lock)
        {
            if (_isSwitching) return;
            _isSwitching = true;
        }

        try
        {
            var confirmed = await _client.SetTrackingModeAsync(mode, serverBaseUrl, apiKey).ConfigureAwait(false);
            lock (_lock)
            {
                _mode = confirmed;
                _lastError = null;
                _lastSwitchCompletedAt = _now();
            }
        }
        catch (Exception ex) when (ex is ApiClientException or HttpRequestException or TaskCanceledException)
        {
            lock (_lock) { _lastError = Describe(ex); }
        }
        finally
        {
            lock (_lock) { _isSwitching = false; }
        }
    }

    /// <summary>The mode the server reported for a request that started at <paramref name="requestStartedAt"/>.</summary>
    public void Report(TrackingMode mode, DateTimeOffset requestStartedAt) => Accept(mode, requestStartedAt);

    private void Accept(TrackingMode mode, DateTimeOffset requestStartedAt)
    {
        lock (_lock)
        {
            if (_isSwitching) return;
            if (_lastSwitchCompletedAt is { } switchedAt && requestStartedAt < switchedAt) return;
            _mode = mode;
        }
    }

    public static string Describe(Exception error) => error switch
    {
        ApiClientException { IsUnauthorized: true } => "API key invalid or revoked",
        ApiClientException { StatusCode: 404 } => "Server doesn't support switching yet (update it)",
        ApiClientException { StatusCode: > 0 } api => $"Server error (HTTP {api.StatusCode})",
        _ => "Server unreachable",
    };
}

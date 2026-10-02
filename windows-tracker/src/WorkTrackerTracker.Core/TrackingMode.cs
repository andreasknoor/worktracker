using System.Text.Json;
using System.Text.Json.Serialization;

namespace WorkTrackerTracker.Core;

/// <summary>
/// The device's server-side work/leisure classification mode, set in the
/// dashboard — mirroring the server's <c>trackingMode</c> values (see
/// docs/API_CONTRACT.md). It only governs time captured while the tracker's
/// own <see cref="WorkTypeSetting"/> is <see cref="WorkTypeSetting.Server"/>.
/// Kept in sync with the Mac tracker's TrackingMode.swift.
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
        TrackingMode.Auto => "Auto",
        TrackingMode.AlwaysWork => "Work",
        TrackingMode.AlwaysLeisure => "Leisure",
        _ => throw new ArgumentOutOfRangeException(nameof(mode)),
    };
}

/// <summary>
/// The work type stamped on a captured event (POST /api/events'
/// <c>workType</c>). Absent (null) means "as defined on the server".
/// </summary>
public enum WorkType
{
    Work,
    Leisure,
}

/// <summary>
/// What the tracker's menu is set to: classify captured time as work, as
/// leisure, or as defined on the server (the device's
/// <see cref="TrackingMode"/>). Applies to every event captured from then on,
/// stamped onto the event itself — so it works offline and is never applied
/// retroactively. <see cref="Server"/> is first so it's also <c>default</c>.
/// </summary>
public enum WorkTypeSetting
{
    Server,
    Work,
    Leisure,
}

public static class WorkTypes
{
    public static IReadOnlyList<WorkTypeSetting> AllSettings { get; } = [WorkTypeSetting.Work, WorkTypeSetting.Leisure, WorkTypeSetting.Server];

    /// <summary>The wire/file value: "work" or "leisure".</summary>
    public static string ToWire(WorkType workType) => workType switch
    {
        WorkType.Work => "work",
        WorkType.Leisure => "leisure",
        _ => throw new ArgumentOutOfRangeException(nameof(workType)),
    };

    public static WorkType? FromWire(string? wire) => wire switch
    {
        "work" => WorkType.Work,
        "leisure" => WorkType.Leisure,
        _ => null,
    };

    /// <summary>What gets stamped on events captured under <paramref name="setting"/>.</summary>
    public static WorkType? Stamped(WorkTypeSetting setting) => setting switch
    {
        WorkTypeSetting.Work => WorkType.Work,
        WorkTypeSetting.Leisure => WorkType.Leisure,
        _ => null,
    };

    /// <summary>The menu entry; <paramref name="serverMode"/> is the device's mode as last reported, null while unknown.</summary>
    public static string MenuTitle(WorkTypeSetting setting, TrackingMode? serverMode) => setting switch
    {
        WorkTypeSetting.Work => "Work",
        WorkTypeSetting.Leisure => "Leisure",
        _ => serverMode is { } mode ? $"As defined on server (currently: {TrackingModes.MenuTitle(mode)})" : "As defined on server",
    };
}

/// <summary>
/// Stores a <see cref="WorkTypeSetting"/> as "server"/"work"/"leisure" (the
/// Mac tracker's spelling), reading a missing or unknown value as
/// <see cref="WorkTypeSetting.Server"/> instead of throwing — a throw would
/// make <see cref="ConfigStore.Load"/> fall back to an empty config and
/// drop the API key.
/// </summary>
public sealed class WorkTypeSettingJsonConverter : JsonConverter<WorkTypeSetting>
{
    public override WorkTypeSetting Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.String)
        {
            reader.Skip();
            return WorkTypeSetting.Server;
        }
        return reader.GetString() switch
        {
            "work" => WorkTypeSetting.Work,
            "leisure" => WorkTypeSetting.Leisure,
            _ => WorkTypeSetting.Server,
        };
    }

    public override void Write(Utf8JsonWriter writer, WorkTypeSetting value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value switch
        {
            WorkTypeSetting.Work => "work",
            WorkTypeSetting.Leisure => "leisure",
            _ => "server",
        });
}

/// <summary>
/// Reads this device's own server-side tracking mode via GET
/// /api/tracker/mode, authenticated with the device's API key. Abstracted so
/// <see cref="TrackingModeController"/> can be tested without a server.
/// </summary>
public interface ITrackingModeApiClient
{
    Task<TrackingMode> GetTrackingModeAsync(string serverBaseUrl, string apiKey, CancellationToken cancellationToken = default);
}

/// <summary>
/// The tracker's view of the device's server-side tracking mode, shown under
/// "As defined on server" in the tray menu. Kept in sync two ways: an
/// explicit read at startup (<see cref="RefreshAsync"/>), and the mode the
/// server reports back on every accepted event batch (<see cref="Report"/>)
/// — which picks up changes made in the dashboard without any extra polling.
/// The tracker never changes this mode itself; its own choice is the local
/// <see cref="WorkTypeSetting"/>.
/// </summary>
/// <remarks>
/// Thread-safe; the lock is never held across an await. Kept in sync with
/// the Mac tracker's TrackingModeController.
/// </remarks>
public sealed class TrackingModeController
{
    private readonly ITrackingModeApiClient _client;
    private readonly object _lock = new();

    private TrackingMode? _mode;

    public TrackingModeController(ITrackingModeApiClient client)
    {
        _client = client;
    }

    /// <summary>Null until the mode is known (not configured, or not yet reachable).</summary>
    public TrackingMode? CurrentMode { get { lock (_lock) { return _mode; } } }

    /// <summary>Forgets everything, e.g. after the server URL or API key changed.</summary>
    public void Reset()
    {
        lock (_lock) { _mode = null; }
    }

    public async Task RefreshAsync(string serverBaseUrl, string apiKey)
    {
        try
        {
            var fetched = await _client.GetTrackingModeAsync(serverBaseUrl, apiKey).ConfigureAwait(false);
            lock (_lock) { _mode = fetched; }
        }
        catch (Exception ex) when (ex is ApiClientException or HttpRequestException or TaskCanceledException)
        {
            // Silent: the mode shows as unknown until a later report fills it in.
        }
    }

    /// <summary>The mode the server reported with an accepted event batch.</summary>
    public void Report(TrackingMode mode)
    {
        lock (_lock) { _mode = mode; }
    }
}

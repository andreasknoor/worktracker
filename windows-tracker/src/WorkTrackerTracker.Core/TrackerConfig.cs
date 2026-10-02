using System.Text.Json;
using System.Text.Json.Serialization;

namespace WorkTrackerTracker.Core;

/// <summary>
/// Tracker configuration: which server to push activity events to, the
/// device's own API key (issued once via POST /api/devices on the
/// dashboard), and how often to poll for input activity. Mirrors the wire
/// protocol in docs/API_CONTRACT.md, shared with the Mac tracker.
/// </summary>
public sealed record TrackerConfig(string ServerBaseUrl, string ApiKey, int PollIntervalSeconds)
{
    public static readonly TrackerConfig Empty = new(string.Empty, string.Empty, 30);

    /// <summary>
    /// How captured time is classified, chosen in the tray menu (not in the
    /// settings dialog). Kept across restarts. A config file written before
    /// v1.30 has no such field and loads as <see cref="WorkTypeSetting.Server"/>.
    /// </summary>
    [JsonConverter(typeof(WorkTypeSettingJsonConverter))]
    public WorkTypeSetting WorkTypeSetting { get; init; } = WorkTypeSetting.Server;

    public bool IsConfigured => !string.IsNullOrEmpty(ServerBaseUrl) && !string.IsNullOrEmpty(ApiKey);
}

/// <summary>
/// Loads and saves <see cref="TrackerConfig"/> as JSON at an explicit file
/// path. The production default location is
/// %AppData%\WorkTracker\config.json (see <see cref="DefaultConfigFilePath"/>);
/// tests point this at a temp file instead.
/// </summary>
public static class ConfigStore
{
    public static string DefaultConfigFilePath() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "WorkTracker", "config.json");

    public static TrackerConfig Load(string path)
    {
        if (!File.Exists(path))
        {
            return TrackerConfig.Empty;
        }

        try
        {
            var json = File.ReadAllText(path);
            return JsonSerializer.Deserialize<TrackerConfig>(json) ?? TrackerConfig.Empty;
        }
        catch (Exception ex) when (ex is JsonException or IOException)
        {
            return TrackerConfig.Empty;
        }
    }

    public static void Save(TrackerConfig config, string path)
    {
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        File.WriteAllText(path, JsonSerializer.Serialize(config));
    }
}

using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace WorkTrackerTracker.Core;

/// <summary>
/// A small local queue of not-yet-sent activity timestamps, persisted to
/// disk so a network blip (or the tracker quitting) doesn't lose events —
/// see docs/API_CONTRACT.md's note on why batched event posting exists.
/// Flushing only clears entries once the server has actually accepted them.
/// </summary>
public sealed class ActivityQueue
{
    private readonly string _storagePath;
    private readonly Func<DateTimeOffset> _now;
    private List<DateTimeOffset> _pending;

    public ActivityQueue(string storagePath, Func<DateTimeOffset>? now = null)
    {
        _storagePath = storagePath;
        _now = now ?? (() => DateTimeOffset.UtcNow);

        var loaded = Load(storagePath);
        _pending = loaded.Pending;
        LastSuccessfulSyncAt = loaded.LastSuccessfulSyncAt;
    }

    public int PendingCount => _pending.Count;

    /// <summary>
    /// When the last batch was actually accepted by the server — not just
    /// attempted. Persisted across restarts (in the same queue file) so the
    /// tray icon shows an accurate value immediately after launch, not
    /// "Last synced: never" just because this process hasn't flushed yet.
    /// </summary>
    public DateTimeOffset? LastSuccessfulSyncAt { get; private set; }

    public void Enqueue(DateTimeOffset timestamp)
    {
        _pending.Add(timestamp);
        Persist();
    }

    /// <summary>
    /// Attempts to send every pending timestamp in one batch. On success the
    /// queue is cleared; on failure everything stays queued for the next
    /// flush attempt (the caller is expected to retry on a timer).
    /// </summary>
    public async Task FlushAsync(IEventsApiClient client, string serverBaseUrl, string apiKey, CancellationToken cancellationToken = default)
    {
        if (_pending.Count == 0)
        {
            return;
        }

        var batch = _pending;
        try
        {
            await client.PostEventsAsync(batch, serverBaseUrl, apiKey, cancellationToken).ConfigureAwait(false);
            _pending = new List<DateTimeOffset>();
            LastSuccessfulSyncAt = _now();
            Persist();
        }
        catch
        {
            // Left queued intentionally; a later flush will retry the same batch.
        }
    }

    private void Persist()
    {
        var directory = Path.GetDirectoryName(_storagePath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var state = new PersistedState
        {
            Pending = _pending.Select(FormatIso8601).ToArray(),
            LastSuccessfulSyncAt = LastSuccessfulSyncAt is { } syncAt ? FormatIso8601(syncAt) : null,
        };
        File.WriteAllText(_storagePath, JsonSerializer.Serialize(state));
    }

    private static string FormatIso8601(DateTimeOffset timestamp) =>
        timestamp.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");

    private static (List<DateTimeOffset> Pending, DateTimeOffset? LastSuccessfulSyncAt) Load(string path)
    {
        if (!File.Exists(path))
        {
            return (new List<DateTimeOffset>(), null);
        }

        var json = File.ReadAllText(path);

        try
        {
            var state = JsonSerializer.Deserialize<PersistedState>(json);
            if (state is not null)
            {
                var pending = ParseTimestamps(state.Pending);
                var lastSync = state.LastSuccessfulSyncAt is { } s && DateTimeOffset.TryParse(s, null, DateTimeStyles.RoundtripKind, out var dt)
                    ? dt
                    : (DateTimeOffset?)null;
                return (pending, lastSync);
            }
        }
        catch (JsonException)
        {
            // Fall through to the legacy shape below.
        }

        try
        {
            // Older queue files are a bare `[String]` of pending timestamps
            // (no LastSuccessfulSyncAt yet) — fall back to that shape so
            // upgrading doesn't drop an existing queue.
            var iso = JsonSerializer.Deserialize<string[]>(json) ?? Array.Empty<string>();
            return (ParseTimestamps(iso), null);
        }
        catch (Exception ex) when (ex is JsonException or IOException)
        {
            return (new List<DateTimeOffset>(), null);
        }
    }

    private static List<DateTimeOffset> ParseTimestamps(IEnumerable<string> iso) =>
        iso
            .Select(s => DateTimeOffset.TryParse(s, null, DateTimeStyles.RoundtripKind, out var dt) ? dt : (DateTimeOffset?)null)
            .Where(dt => dt.HasValue)
            .Select(dt => dt!.Value)
            .ToList();

    private sealed class PersistedState
    {
        [JsonPropertyName("pending")]
        public string[] Pending { get; set; } = Array.Empty<string>();

        [JsonPropertyName("lastSuccessfulSyncAt")]
        public string? LastSuccessfulSyncAt { get; set; }
    }
}

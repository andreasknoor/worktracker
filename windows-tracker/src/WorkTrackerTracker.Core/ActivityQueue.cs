using System.Text.Json;

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
    private List<DateTimeOffset> _pending;

    public ActivityQueue(string storagePath)
    {
        _storagePath = storagePath;
        _pending = Load(storagePath);
    }

    public int PendingCount => _pending.Count;

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

        var iso = _pending.Select(t => t.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")).ToArray();
        File.WriteAllText(_storagePath, JsonSerializer.Serialize(iso));
    }

    private static List<DateTimeOffset> Load(string path)
    {
        if (!File.Exists(path))
        {
            return new List<DateTimeOffset>();
        }

        try
        {
            var iso = JsonSerializer.Deserialize<string[]>(File.ReadAllText(path)) ?? Array.Empty<string>();
            return iso
                .Select(s => DateTimeOffset.TryParse(s, null, System.Globalization.DateTimeStyles.RoundtripKind, out var dt) ? dt : (DateTimeOffset?)null)
                .Where(dt => dt.HasValue)
                .Select(dt => dt!.Value)
                .ToList();
        }
        catch (Exception ex) when (ex is JsonException or IOException)
        {
            return new List<DateTimeOffset>();
        }
    }
}

using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace WorkTrackerTracker.Core;

/// <summary>
/// A small local queue of not-yet-sent activity timestamps, persisted to
/// disk so a network blip (or the tracker quitting) doesn't lose events —
/// see docs/API_CONTRACT.md's note on why batched event posting exists.
/// Only entries the server has actually accepted are ever removed.
/// </summary>
/// <remarks>
/// Behavior during a sustained server outage (kept in sync with the Mac
/// tracker's ActivityQueue.swift):
/// <list type="bullet">
/// <item>FlushAsync sends in chunks of at most <c>chunkSize</c> timestamps,
/// under the server's per-request cap, and removes each chunk as soon as
/// it's acknowledged, so a huge backlog drains in pieces.</item>
/// <item>Only the entries that were actually sent are removed; timestamps
/// enqueued while a request was in flight stay queued.</item>
/// <item>Repeated failures back off exponentially.</item>
/// <item>A chunk the server rejects as invalid (HTTP 400/413/422) is dropped
/// rather than retried forever, so it can't block everything behind it.</item>
/// <item>The queue is capped very generously; once full the oldest entries
/// are dropped and counted in <see cref="DroppedEventCount"/>.</item>
/// </list>
/// Thread-safety: Enqueue runs on the UI thread, while the continuation of
/// FlushAsync may resume on a pool thread (ConfigureAwait(false)); shared
/// state is guarded by a lock that is never held across an await.
/// </remarks>
public sealed class ActivityQueue
{
    /// <summary>~30 bytes per entry on disk: 100k entries is ~3 MB.</summary>
    public const int DefaultMaxPendingCount = 100_000;

    /// <summary>Must stay at or below the server's MAX_EVENTS_PER_REQUEST (src/server/app.ts).</summary>
    public const int DefaultChunkSize = 1000;

    public static readonly TimeSpan DefaultBaseBackoff = TimeSpan.FromSeconds(15);
    public static readonly TimeSpan DefaultMaxBackoff = TimeSpan.FromSeconds(300);

    /// <summary>
    /// Pending changes are written to disk at most this often; a graceful
    /// exit calls <see cref="PersistNow"/>.
    /// </summary>
    public static readonly TimeSpan DefaultPersistDebounce = TimeSpan.FromSeconds(5);

    private readonly object _lock = new();
    private readonly string _storagePath;
    private readonly Func<DateTimeOffset> _now;
    private readonly int _maxPendingCount;
    private readonly int _chunkSize;
    private readonly TimeSpan _baseBackoff;
    private readonly TimeSpan _maxBackoff;
    private readonly TimeSpan _persistDebounce;

    private List<DateTimeOffset> _pending;
    private long _headSequence; // sequence number of _pending[0]
    private DateTimeOffset? _lastPersistedAt;
    private bool _hasUnpersistedChanges;
    private int _consecutiveFailureCount;
    private DateTimeOffset? _nextAllowedFlushAt;
    private bool _isFlushing;
    private DateTimeOffset? _lastSuccessfulSyncAt;
    private string? _lastError;
    private int _droppedEventCount;

    public ActivityQueue(
        string storagePath,
        Func<DateTimeOffset>? now = null,
        int maxPendingCount = DefaultMaxPendingCount,
        int chunkSize = DefaultChunkSize,
        TimeSpan? baseBackoff = null,
        TimeSpan? maxBackoff = null,
        TimeSpan? persistDebounce = null)
    {
        _storagePath = storagePath;
        _now = now ?? (() => DateTimeOffset.UtcNow);
        _maxPendingCount = maxPendingCount;
        _chunkSize = Math.Max(1, chunkSize);
        _baseBackoff = baseBackoff ?? DefaultBaseBackoff;
        _maxBackoff = maxBackoff ?? DefaultMaxBackoff;
        _persistDebounce = persistDebounce ?? DefaultPersistDebounce;

        var loaded = Load(storagePath);
        _pending = loaded.Pending;
        _lastSuccessfulSyncAt = loaded.LastSuccessfulSyncAt;
    }

    public int PendingCount { get { lock (_lock) return _pending.Count; } }

    /// <summary>Snapshot of the queued timestamps; exposed for tests.</summary>
    public IReadOnlyList<DateTimeOffset> PendingTimestamps { get { lock (_lock) return _pending.ToArray(); } }

    /// <summary>
    /// When the last batch was actually accepted by the server — not just
    /// attempted. Persisted across restarts (in the same queue file).
    /// </summary>
    public DateTimeOffset? LastSuccessfulSyncAt { get { lock (_lock) return _lastSuccessfulSyncAt; } }

    /// <summary>Why the most recent flush failed, or null after a success.</summary>
    public string? LastError { get { lock (_lock) return _lastError; } }

    /// <summary>Entries discarded this session: evicted by the cap or rejected as invalid.</summary>
    public int DroppedEventCount { get { lock (_lock) return _droppedEventCount; } }

    /// <summary>Consecutive failed flushes since the last success; exposed for tests.</summary>
    public int ConsecutiveFailureCount { get { lock (_lock) return _consecutiveFailureCount; } }

    public void Enqueue(DateTimeOffset timestamp)
    {
        lock (_lock)
        {
            _pending.Add(timestamp);
            if (_pending.Count > _maxPendingCount)
            {
                var overflow = _pending.Count - _maxPendingCount;
                _pending.RemoveRange(0, overflow);
                _headSequence += overflow;
                _droppedEventCount += overflow;
            }
            _hasUnpersistedChanges = true;
            PersistIfDebounceElapsed();
        }
    }

    /// <summary>
    /// Sends everything pending, one chunk at a time, stopping at the first
    /// failure. A call that arrives while another flush is running, or
    /// before the backoff window has elapsed, is a cheap no-op, so the
    /// caller's fixed-interval timer can call this on every tick.
    /// </summary>
    public async Task FlushAsync(IEventsApiClient client, string serverBaseUrl, string apiKey, CancellationToken cancellationToken = default)
    {
        if (!BeginFlush())
        {
            return;
        }

        try
        {
            while (NextChunk() is { } chunk)
            {
                try
                {
                    await client.PostEventsAsync(chunk.Timestamps, serverBaseUrl, apiKey, cancellationToken).ConfigureAwait(false);
                    CompleteChunk(chunk.EndSequence, rejected: false);
                }
                catch (ApiClientException ex) when (ex.IsPermanentRejection)
                {
                    // The server understood the request and refuses this
                    // data; retrying the same chunk would block the queue.
                    CompleteChunk(chunk.EndSequence, rejected: true);
                    lock (_lock) _lastError = $"Server rejected {chunk.Timestamps.Length} event(s) as invalid";
                }
                catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
                {
                    RecordFailure(ex);
                    return;
                }
            }
        }
        finally
        {
            lock (_lock) _isFlushing = false;
        }
    }

    private bool BeginFlush()
    {
        lock (_lock)
        {
            if (_isFlushing || _pending.Count == 0) return false;
            if (_nextAllowedFlushAt is { } next && _now() < next) return false;
            _isFlushing = true;
            return true;
        }
    }

    private (DateTimeOffset[] Timestamps, long EndSequence)? NextChunk()
    {
        lock (_lock)
        {
            if (_pending.Count == 0) return null;
            var chunk = _pending.Take(_chunkSize).ToArray();
            return (chunk, _headSequence + chunk.Length);
        }
    }

    /// <summary>Removes exactly the entries up to <paramref name="endSequence"/>, never more.</summary>
    private void CompleteChunk(long endSequence, bool rejected)
    {
        lock (_lock)
        {
            var removable = (int)Math.Min(Math.Max(0, endSequence - _headSequence), _pending.Count);
            _pending.RemoveRange(0, removable);
            _headSequence += removable;
            if (rejected)
            {
                _droppedEventCount += removable;
            }
            else
            {
                _consecutiveFailureCount = 0;
                _nextAllowedFlushAt = null;
                _lastError = null;
                _lastSuccessfulSyncAt = _now();
            }
            _hasUnpersistedChanges = true;
            Persist();
        }
    }

    private void RecordFailure(Exception error)
    {
        lock (_lock)
        {
            _consecutiveFailureCount++;
            _nextAllowedFlushAt = _now() + BackoffInterval(_consecutiveFailureCount, _baseBackoff, _maxBackoff);
            _lastError = Describe(error);
        }
    }

    private static string Describe(Exception error) => error switch
    {
        ApiClientException { IsUnauthorized: true } => "API key invalid or revoked",
        ApiClientException { StatusCode: { } status } => $"Server error (HTTP {status})",
        ApiClientException ex => ex.Message,
        _ => "Server unreachable",
    };

    /// <summary>Doubles with each consecutive failure (base, 2x, 4x, ...), capped at <paramref name="max"/>.</summary>
    public static TimeSpan BackoffInterval(int consecutiveFailures, TimeSpan baseInterval, TimeSpan max)
    {
        if (consecutiveFailures <= 0) return TimeSpan.Zero;
        var seconds = baseInterval.TotalSeconds * Math.Pow(2, consecutiveFailures - 1);
        return TimeSpan.FromSeconds(Math.Min(seconds, max.TotalSeconds));
    }

    /// <summary>Forces pending changes to disk now, bypassing the debounce. Call on graceful exit.</summary>
    public void PersistNow()
    {
        lock (_lock)
        {
            if (_hasUnpersistedChanges) Persist();
        }
    }

    // Caller holds _lock.
    private void PersistIfDebounceElapsed()
    {
        if (_lastPersistedAt is { } last && _now() - last < _persistDebounce)
        {
            return;
        }
        Persist();
    }

    /// <summary>
    /// Caller holds _lock. Writes to a temp file and swaps it in, so a crash
    /// mid-write can't leave a truncated queue. A failed write is swallowed
    /// (the queue stays in memory and the next attempt retries) rather than
    /// crashing the tray app from inside a timer tick.
    /// </summary>
    private void Persist()
    {
        _lastPersistedAt = _now();
        try
        {
            var directory = Path.GetDirectoryName(_storagePath);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            var state = new PersistedState
            {
                Pending = _pending.Select(FormatIso8601).ToArray(),
                LastSuccessfulSyncAt = _lastSuccessfulSyncAt is { } syncAt ? FormatIso8601(syncAt) : null,
            };
            var tempPath = _storagePath + ".tmp";
            File.WriteAllText(tempPath, JsonSerializer.Serialize(state));
            File.Move(tempPath, _storagePath, overwrite: true);
            _hasUnpersistedChanges = false;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _hasUnpersistedChanges = true;
        }
    }

    private static string FormatIso8601(DateTimeOffset timestamp) =>
        timestamp.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);

    private static (List<DateTimeOffset> Pending, DateTimeOffset? LastSuccessfulSyncAt) Load(string path)
    {
        if (!File.Exists(path))
        {
            return (new List<DateTimeOffset>(), null);
        }

        string json;
        try
        {
            json = File.ReadAllText(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Unreadable right now (e.g. locked): start empty but leave the
            // file alone — the next successful persist replaces it, and we
            // must not treat this as corruption.
            return (new List<DateTimeOffset>(), null);
        }

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
        catch (JsonException)
        {
            Quarantine(path);
            return (new List<DateTimeOffset>(), null);
        }
    }

    /// <summary>Keeps an unparseable queue file for manual recovery instead of overwriting it with an empty queue.</summary>
    private static void Quarantine(string path)
    {
        try
        {
            File.Move(path, path + ".corrupt", overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Best effort.
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

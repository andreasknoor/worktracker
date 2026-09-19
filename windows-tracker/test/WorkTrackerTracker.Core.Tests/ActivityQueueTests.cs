using WorkTrackerTracker.Core;

namespace WorkTrackerTracker.Core.Tests;

file sealed class FakeEventsApiClient : IEventsApiClient
{
    public bool ShouldFail { get; set; }
    public ApiClientException Failure { get; set; } = new("simulated failure", 500);
    /// <summary>Runs while a request is "in flight", to simulate activity arriving mid-flush.</summary>
    public Action? OnPost { get; set; }
    public List<IReadOnlyList<DateTimeOffset>> ReceivedBatches { get; } = new();

    public Task PostEventsAsync(IReadOnlyList<DateTimeOffset> timestamps, string serverBaseUrl, string apiKey, CancellationToken cancellationToken = default)
    {
        ReceivedBatches.Add(timestamps.ToArray());
        OnPost?.Invoke();
        if (ShouldFail)
        {
            throw Failure;
        }
        return Task.CompletedTask;
    }
}

public sealed class ActivityQueueTests : IDisposable
{
    private readonly string _tempFile = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString(), "queue.json");

    public void Dispose()
    {
        var directory = Path.GetDirectoryName(_tempFile);
        if (directory is not null && Directory.Exists(directory))
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void NewQueue_StartsEmpty()
    {
        var queue = new ActivityQueue(_tempFile);
        Assert.Equal(0, queue.PendingCount);
    }

    [Fact]
    public void Enqueue_IncrementsPendingCount()
    {
        var queue = new ActivityQueue(_tempFile);
        queue.Enqueue(DateTimeOffset.UtcNow);
        queue.Enqueue(DateTimeOffset.UtcNow);
        Assert.Equal(2, queue.PendingCount);
    }

    [Fact]
    public async Task Flush_OnSuccess_ClearsTheQueueAndSendsOneBatch()
    {
        var queue = new ActivityQueue(_tempFile);
        queue.Enqueue(DateTimeOffset.UtcNow);
        queue.Enqueue(DateTimeOffset.UtcNow);
        var client = new FakeEventsApiClient();

        await queue.FlushAsync(client, "https://example.vercel.app", "wtk_live_x");

        Assert.Equal(0, queue.PendingCount);
        Assert.Single(client.ReceivedBatches);
        Assert.Equal(2, client.ReceivedBatches[0].Count);
    }

    [Fact]
    public async Task Flush_OnFailure_KeepsEventsQueuedForRetry()
    {
        var queue = new ActivityQueue(_tempFile);
        queue.Enqueue(DateTimeOffset.UtcNow);
        var client = new FakeEventsApiClient { ShouldFail = true };

        await queue.FlushAsync(client, "https://example.vercel.app", "wtk_live_x");

        Assert.Equal(1, queue.PendingCount);
    }

    [Fact]
    public async Task Flush_OnEmptyQueue_DoesNotCallTheClient()
    {
        var queue = new ActivityQueue(_tempFile);
        var client = new FakeEventsApiClient();

        await queue.FlushAsync(client, "https://example.vercel.app", "wtk_live_x");

        Assert.Empty(client.ReceivedBatches);
    }

    [Fact]
    public void QueueSurvivesRestart_ByPersistingToDisk()
    {
        var first = new ActivityQueue(_tempFile, persistDebounce: TimeSpan.Zero);
        first.Enqueue(DateTimeOffset.UtcNow);
        first.Enqueue(DateTimeOffset.UtcNow);

        var second = new ActivityQueue(_tempFile);
        Assert.Equal(2, second.PendingCount);
    }

    [Fact]
    public async Task AfterSuccessfulFlush_AFreshInstanceHasNothingQueued()
    {
        var first = new ActivityQueue(_tempFile);
        first.Enqueue(DateTimeOffset.UtcNow);
        await first.FlushAsync(new FakeEventsApiClient(), "https://example.vercel.app", "k");

        var second = new ActivityQueue(_tempFile);
        Assert.Equal(0, second.PendingCount);
    }

    [Fact]
    public void LastSuccessfulSyncAt_IsNullInitially()
    {
        var queue = new ActivityQueue(_tempFile);
        Assert.Null(queue.LastSuccessfulSyncAt);
    }

    [Fact]
    public async Task Flush_OnSuccess_SetsLastSuccessfulSyncAt()
    {
        var now = new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);
        var queue = new ActivityQueue(_tempFile, () => now);
        queue.Enqueue(now);

        await queue.FlushAsync(new FakeEventsApiClient(), "https://example.vercel.app", "k");

        Assert.Equal(now, queue.LastSuccessfulSyncAt);
    }

    [Fact]
    public async Task Flush_OnFailure_DoesNotSetLastSuccessfulSyncAt()
    {
        var queue = new ActivityQueue(_tempFile);
        queue.Enqueue(DateTimeOffset.UtcNow);
        var client = new FakeEventsApiClient { ShouldFail = true };

        await queue.FlushAsync(client, "https://example.vercel.app", "k");

        Assert.Null(queue.LastSuccessfulSyncAt);
    }

    [Fact]
    public async Task LastSuccessfulSyncAt_SurvivesRestart_ByPersistingToDisk()
    {
        var now = new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);
        var first = new ActivityQueue(_tempFile, () => now);
        first.Enqueue(now);
        await first.FlushAsync(new FakeEventsApiClient(), "https://example.vercel.app", "k");

        var second = new ActivityQueue(_tempFile);
        Assert.Equal(now, second.LastSuccessfulSyncAt);
    }

    [Fact]
    public void LoadsAnOlderQueueFile_WrittenBeforeLastSuccessfulSyncAtExisted()
    {
        // Pre-upgrade queue files are a bare `[String]` of ISO 8601
        // timestamps, with no lastSuccessfulSyncAt field at all.
        var directory = Path.GetDirectoryName(_tempFile)!;
        Directory.CreateDirectory(directory);
        var legacyJson = System.Text.Json.JsonSerializer.Serialize(new[] { DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") });
        File.WriteAllText(_tempFile, legacyJson);

        var queue = new ActivityQueue(_tempFile);

        Assert.Equal(1, queue.PendingCount);
        Assert.Null(queue.LastSuccessfulSyncAt);
    }

    // ---- Outage resilience ----

    private const string Url = "https://example.vercel.app";
    private static DateTimeOffset T(int seconds) => DateTimeOffset.FromUnixTimeSeconds(seconds);

    [Fact]
    public async Task Flush_SendsLargeBacklogInChunks_AndClearsAll()
    {
        var queue = new ActivityQueue(_tempFile, chunkSize: 100, persistDebounce: TimeSpan.Zero);
        for (var i = 0; i < 250; i++) queue.Enqueue(T(i));
        var client = new FakeEventsApiClient();

        await queue.FlushAsync(client, Url, "k");

        Assert.Equal(new[] { 100, 100, 50 }, client.ReceivedBatches.Select(b => b.Count));
        Assert.Equal(0, queue.PendingCount);
    }

    [Fact]
    public async Task Flush_FailureMidBacklog_KeepsOnlyUnsentChunks()
    {
        var queue = new ActivityQueue(_tempFile, chunkSize: 100, persistDebounce: TimeSpan.Zero);
        for (var i = 0; i < 250; i++) queue.Enqueue(T(i));
        var client = new FakeEventsApiClient();
        var calls = 0;
        client.OnPost = () => client.ShouldFail = ++calls >= 2;

        await queue.FlushAsync(client, Url, "k");

        Assert.Equal(150, queue.PendingCount);
        Assert.Equal(T(100), queue.PendingTimestamps[0]);
    }

    [Fact]
    public async Task Flush_KeepsEventsEnqueuedWhileRequestIsInFlight()
    {
        var queue = new ActivityQueue(_tempFile, persistDebounce: TimeSpan.Zero);
        queue.Enqueue(T(1));
        var client = new FakeEventsApiClient();
        var injected = false;
        client.OnPost = () =>
        {
            if (injected) return;
            injected = true;
            queue.Enqueue(T(2));
        };

        await queue.FlushAsync(client, Url, "k");

        Assert.Equal(new[] { T(1) }, client.ReceivedBatches[0]);
        Assert.Equal(2, client.ReceivedBatches.Sum(b => b.Count)); // late arrival sent by the next chunk, not lost
        Assert.Equal(0, queue.PendingCount);
    }

    [Fact]
    public async Task Flush_CapEvictionDuringFlight_DoesNotRemoveUnsentEntries()
    {
        var queue = new ActivityQueue(_tempFile, maxPendingCount: 3, persistDebounce: TimeSpan.Zero);
        for (var i = 0; i < 3; i++) queue.Enqueue(T(i));
        var client = new FakeEventsApiClient();
        var first = true;
        client.OnPost = () =>
        {
            if (!first) return;
            first = false;
            queue.Enqueue(T(3)); // evicts 0
            queue.Enqueue(T(4)); // evicts 1
        };

        await queue.FlushAsync(client, Url, "k");

        Assert.Equal(0, queue.PendingCount);
        Assert.Equal(T(4), client.ReceivedBatches.SelectMany(b => b).Last());
    }

    [Fact]
    public async Task Flush_PermanentRejection_DropsChunkAndContinues()
    {
        var queue = new ActivityQueue(_tempFile, chunkSize: 2, persistDebounce: TimeSpan.Zero);
        for (var i = 0; i < 4; i++) queue.Enqueue(T(i));
        var client = new FakeEventsApiClient { Failure = new ApiClientException("bad", 400) };
        var calls = 0;
        client.OnPost = () => client.ShouldFail = ++calls == 1;

        await queue.FlushAsync(client, Url, "k");

        Assert.Equal(0, queue.PendingCount);
        Assert.Equal(2, queue.DroppedEventCount);
        Assert.Equal(2, client.ReceivedBatches.Count);
    }

    [Fact]
    public async Task Flush_Unauthorized_KeepsDataBacksOffAndReportsError()
    {
        var queue = new ActivityQueue(_tempFile);
        queue.Enqueue(T(1));
        var client = new FakeEventsApiClient { ShouldFail = true, Failure = new ApiClientException("nope", 401) };

        await queue.FlushAsync(client, Url, "k");

        Assert.Equal(1, queue.PendingCount);
        Assert.Equal("API key invalid or revoked", queue.LastError);
        Assert.Equal(1, queue.ConsecutiveFailureCount);
    }

    [Fact]
    public async Task Flush_AfterFailure_SkipsRetryUntilBackoffElapses()
    {
        var now = new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);
        var queue = new ActivityQueue(_tempFile, () => now, baseBackoff: TimeSpan.FromSeconds(10));
        queue.Enqueue(now);
        var client = new FakeEventsApiClient { ShouldFail = true };

        await queue.FlushAsync(client, Url, "k");
        now += TimeSpan.FromSeconds(5);
        await queue.FlushAsync(client, Url, "k");
        Assert.Single(client.ReceivedBatches);

        now += TimeSpan.FromSeconds(6);
        await queue.FlushAsync(client, Url, "k");
        Assert.Equal(2, client.ReceivedBatches.Count);
        Assert.Equal(2, queue.ConsecutiveFailureCount);
    }

    [Fact]
    public void BackoffInterval_DoublesUpToCap()
    {
        var b = TimeSpan.FromSeconds(10);
        var max = TimeSpan.FromSeconds(100);
        Assert.Equal(TimeSpan.FromSeconds(10), ActivityQueue.BackoffInterval(1, b, max));
        Assert.Equal(TimeSpan.FromSeconds(40), ActivityQueue.BackoffInterval(3, b, max));
        Assert.Equal(TimeSpan.FromSeconds(100), ActivityQueue.BackoffInterval(6, b, max));
    }

    [Fact]
    public async Task Flush_Success_ClearsLastError()
    {
        var now = new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);
        var queue = new ActivityQueue(_tempFile, () => now, baseBackoff: TimeSpan.FromSeconds(10));
        queue.Enqueue(now);
        var client = new FakeEventsApiClient { ShouldFail = true };
        await queue.FlushAsync(client, Url, "k");
        Assert.NotNull(queue.LastError);

        client.ShouldFail = false;
        now += TimeSpan.FromSeconds(20);
        await queue.FlushAsync(client, Url, "k");

        Assert.Null(queue.LastError);
    }

    [Fact]
    public void Enqueue_BeyondCap_DropsOldestAndCounts()
    {
        var queue = new ActivityQueue(_tempFile, maxPendingCount: 2, persistDebounce: TimeSpan.Zero);
        for (var i = 0; i < 5; i++) queue.Enqueue(T(i));

        Assert.Equal(new[] { T(3), T(4) }, queue.PendingTimestamps);
        Assert.Equal(3, queue.DroppedEventCount);
    }

    [Fact]
    public void Enqueue_WithinDebounceWindow_IsOnlyPersistedByPersistNow()
    {
        var now = new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);
        var first = new ActivityQueue(_tempFile, () => now, persistDebounce: TimeSpan.FromSeconds(5));
        first.Enqueue(T(1));
        now += TimeSpan.FromSeconds(1);
        first.Enqueue(T(2));
        Assert.Equal(1, new ActivityQueue(_tempFile).PendingCount);

        first.PersistNow();
        Assert.Equal(2, new ActivityQueue(_tempFile).PendingCount);
    }

    [Fact]
    public void Load_CorruptQueueFile_IsQuarantinedNotOverwritten()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_tempFile)!);
        File.WriteAllText(_tempFile, "{not json");

        var queue = new ActivityQueue(_tempFile, persistDebounce: TimeSpan.Zero);
        queue.Enqueue(T(1));

        Assert.Equal(1, queue.PendingCount);
        Assert.Equal("{not json", File.ReadAllText(_tempFile + ".corrupt"));
    }

    // ---- Backward compatibility with queue files written by the previous version ----

    [Fact]
    public async Task ExistingQueueFileWith3000Events_LoadsAndIsFullyDeliveredInChunks()
    {
        // Exactly the shape the previous version wrote: an object with
        // "pending" and "lastSuccessfulSyncAt", ms-precision Z timestamps.
        Directory.CreateDirectory(Path.GetDirectoryName(_tempFile)!);
        var stamps = Enumerable.Range(0, 3000).Select(i => T(1_700_000_000 + i * 30).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")).ToArray();
        File.WriteAllText(_tempFile, System.Text.Json.JsonSerializer.Serialize(new { pending = stamps, lastSuccessfulSyncAt = "2026-01-01T00:00:00.000Z" }));

        var queue = new ActivityQueue(_tempFile);
        Assert.Equal(3000, queue.PendingCount);
        Assert.NotNull(queue.LastSuccessfulSyncAt);

        var client = new FakeEventsApiClient();
        await queue.FlushAsync(client, Url, "k");

        Assert.Equal(3000, client.ReceivedBatches.Sum(b => b.Count));
        Assert.All(client.ReceivedBatches, b => Assert.True(b.Count <= ActivityQueue.DefaultChunkSize));
        Assert.Equal(0, queue.PendingCount);
    }
}

using WorkTrackerTracker.Core;

namespace WorkTrackerTracker.Core.Tests;

file sealed class FakeEventsApiClient : IEventsApiClient
{
    public bool ShouldFail { get; set; }
    public List<IReadOnlyList<DateTimeOffset>> ReceivedBatches { get; } = new();

    public Task PostEventsAsync(IReadOnlyList<DateTimeOffset> timestamps, string serverBaseUrl, string apiKey, CancellationToken cancellationToken = default)
    {
        ReceivedBatches.Add(timestamps);
        if (ShouldFail)
        {
            throw new ApiClientException("simulated failure");
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
        var first = new ActivityQueue(_tempFile);
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
}

using WorkTrackerTracker.Core;

namespace WorkTrackerTracker.Core.Tests;

public sealed class ConfigStoreTests : IDisposable
{
    private readonly string _tempFile = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString(), "config.json");

    public void Dispose()
    {
        var directory = Path.GetDirectoryName(_tempFile);
        if (directory is not null && Directory.Exists(directory))
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void Load_WithNothingSaved_ReturnsEmptyDefaults()
    {
        var config = ConfigStore.Load(_tempFile);

        Assert.Equal(TrackerConfig.Empty, config);
        Assert.False(config.IsConfigured);
    }

    [Fact]
    public void Save_ThenLoad_RoundTrips()
    {
        var saved = new TrackerConfig("https://worktracker.example.vercel.app", "wtk_live_abc123", 45);

        ConfigStore.Save(saved, _tempFile);
        var loaded = ConfigStore.Load(_tempFile);

        Assert.Equal(saved, loaded);
    }

    [Fact]
    public void Save_CreatesIntermediateDirectories()
    {
        ConfigStore.Save(TrackerConfig.Empty, _tempFile);

        Assert.True(File.Exists(_tempFile));
    }

    [Theory]
    [InlineData("", "", false)]
    [InlineData("https://x.example", "", false)]
    [InlineData("", "wtk_live_x", false)]
    [InlineData("https://x.example", "wtk_live_x", true)]
    public void IsConfigured_RequiresBothServerUrlAndApiKey(string serverUrl, string apiKey, bool expected)
    {
        var config = new TrackerConfig(serverUrl, apiKey, 30);

        Assert.Equal(expected, config.IsConfigured);
    }
}

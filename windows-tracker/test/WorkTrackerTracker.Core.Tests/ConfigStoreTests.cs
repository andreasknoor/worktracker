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
    public void WorkTypeSetting_DefaultsToServer_AndRoundTrips()
    {
        var saved = new TrackerConfig("https://x.example", "wtk_live_x", 30);
        Assert.Equal(WorkTypeSetting.Server, saved.WorkTypeSetting);

        ConfigStore.Save(saved with { WorkTypeSetting = WorkTypeSetting.Leisure }, _tempFile);

        Assert.Contains("\"WorkTypeSetting\":\"leisure\"", File.ReadAllText(_tempFile));
        Assert.Equal(WorkTypeSetting.Leisure, ConfigStore.Load(_tempFile).WorkTypeSetting);
    }

    [Fact]
    public void Load_AConfigWrittenBeforeWorkTypeSettingExisted_KeepsTheApiKey()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_tempFile)!);
        File.WriteAllText(_tempFile, """{"ServerBaseUrl":"https://x.example","ApiKey":"wtk_live_x","PollIntervalSeconds":45}""");

        var loaded = ConfigStore.Load(_tempFile);

        Assert.Equal("wtk_live_x", loaded.ApiKey);
        Assert.Equal(45, loaded.PollIntervalSeconds);
        Assert.Equal(WorkTypeSetting.Server, loaded.WorkTypeSetting);
    }

    [Theory]
    [InlineData("\"sometimes\"")]
    [InlineData("2")]
    [InlineData("null")]
    public void Load_AnUnknownWorkTypeSetting_FallsBackToServer(string value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_tempFile)!);
        File.WriteAllText(_tempFile, $$"""{"ServerBaseUrl":"https://x.example","ApiKey":"wtk_live_x","PollIntervalSeconds":30,"WorkTypeSetting":{{value}}}""");

        var loaded = ConfigStore.Load(_tempFile);

        Assert.Equal("wtk_live_x", loaded.ApiKey);
        Assert.Equal(WorkTypeSetting.Server, loaded.WorkTypeSetting);
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

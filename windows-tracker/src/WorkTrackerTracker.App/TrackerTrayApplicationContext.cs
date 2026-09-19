using WorkTrackerTracker.Core;

namespace WorkTrackerTracker.App;

/// <summary>
/// Wires together config, the activity queue, idle detection, and the tray
/// icon — no visible main form, matching how the Mac tracker's
/// AppDelegate.swift runs as a menu-bar-only app.
/// </summary>
internal sealed class TrackerTrayApplicationContext : ApplicationContext
{
    private readonly string _configFilePath = ConfigStore.DefaultConfigFilePath();
    private readonly string _queueFilePath;
    private readonly IEventsApiClient _apiClient = new HttpEventsApiClient();
    private readonly ActivityQueue _activityQueue;
    private readonly TrayIconController _trayIcon;

    private TrackerConfig _config;
    private IdleMonitor? _idleMonitor;
    private System.Windows.Forms.Timer? _flushTimer;

    public TrackerTrayApplicationContext()
    {
        _queueFilePath = Path.Combine(Path.GetDirectoryName(_configFilePath)!, "queue.json");

        _config = ConfigStore.Load(_configFilePath);
        _activityQueue = new ActivityQueue(_queueFilePath);

        _trayIcon = new TrayIconController(_config);
        _trayIcon.SettingsSaved += ApplyConfig;

        ApplyConfig(_config);
    }

    private void ApplyConfig(TrackerConfig newConfig)
    {
        _config = newConfig;
        ConfigStore.Save(_config, _configFilePath);

        _idleMonitor?.Stop();
        _idleMonitor?.Dispose();
        _idleMonitor = null;

        _flushTimer?.Stop();
        _flushTimer?.Dispose();
        _flushTimer = null;

        if (!_config.IsConfigured)
        {
            UpdateTray(isActive: false);
            return;
        }

        var pollInterval = TimeSpan.FromSeconds(_config.PollIntervalSeconds);

        _idleMonitor = new IdleMonitor(pollInterval, RecordActivity);
        _idleMonitor.Start();

        // Flush at least as often as we poll, but never more than every
        // MinFlushInterval, so the dashboard's live view sees fresh data.
        var flushInterval = pollInterval > TrackerConstants.MinFlushInterval ? pollInterval : TrackerConstants.MinFlushInterval;
        _flushTimer = new System.Windows.Forms.Timer { Interval = (int)flushInterval.TotalMilliseconds };
        _flushTimer.Tick += async (_, _) => await FlushQueueAsync();
        _flushTimer.Start();

        UpdateTray(isActive: false);
    }

    private void RecordActivity()
    {
        _activityQueue.Enqueue(DateTimeOffset.UtcNow);
        UpdateTray(isActive: true);
    }

    private void UpdateTray(bool isActive) =>
        _trayIcon.Update(isActive, _activityQueue.PendingCount, _activityQueue.LastSuccessfulSyncAt, _activityQueue.LastError);

    // Persistence is debounced (see ActivityQueue), so force a final write
    // on a graceful exit instead of accepting even that small loss window.
    protected override void ExitThreadCore()
    {
        _activityQueue.PersistNow();
        base.ExitThreadCore();
    }

    private async Task FlushQueueAsync()
    {
        await _activityQueue.FlushAsync(_apiClient, _config.ServerBaseUrl, _config.ApiKey).ConfigureAwait(true);
        UpdateTray(isActive: false);
    }
}

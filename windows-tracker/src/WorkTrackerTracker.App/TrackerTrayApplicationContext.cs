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
            _trayIcon.Update(isActive: false, _activityQueue.PendingCount);
            return;
        }

        var pollInterval = TimeSpan.FromSeconds(_config.PollIntervalSeconds);

        _idleMonitor = new IdleMonitor(pollInterval, RecordActivity);
        _idleMonitor.Start();

        // Flush at least as often as we poll, but never more than every 15s,
        // so the dashboard's live view (polled every 15s) sees fresh data.
        var flushInterval = pollInterval > TimeSpan.FromSeconds(15) ? pollInterval : TimeSpan.FromSeconds(15);
        _flushTimer = new System.Windows.Forms.Timer { Interval = (int)flushInterval.TotalMilliseconds };
        _flushTimer.Tick += async (_, _) => await FlushQueueAsync();
        _flushTimer.Start();

        _trayIcon.Update(isActive: false, _activityQueue.PendingCount);
    }

    private void RecordActivity()
    {
        _activityQueue.Enqueue(DateTimeOffset.UtcNow);
        _trayIcon.Update(isActive: true, _activityQueue.PendingCount);
    }

    private async Task FlushQueueAsync()
    {
        await _activityQueue.FlushAsync(_apiClient, _config.ServerBaseUrl, _config.ApiKey).ConfigureAwait(true);
        _trayIcon.Update(isActive: false, _activityQueue.PendingCount);
    }
}

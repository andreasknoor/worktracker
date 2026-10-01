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
    private readonly HttpEventsApiClient _apiClient = new();
    private readonly ActivityQueue _activityQueue;
    private readonly TrackingModeController _trackingMode;
    private readonly TrayIconController _trayIcon;

    private TrackerConfig _config;
    private IdleMonitor? _idleMonitor;
    private System.Windows.Forms.Timer? _flushTimer;

    public TrackerTrayApplicationContext()
    {
        _queueFilePath = Path.Combine(Path.GetDirectoryName(_configFilePath)!, "queue.json");

        _config = ConfigStore.Load(_configFilePath);
        _activityQueue = new ActivityQueue(_queueFilePath);

        _trackingMode = new TrackingModeController(_apiClient);
        // Every accepted event batch reports the device's current mode (e.g.
        // after a change in the dashboard). Raised on a pool thread, so only
        // the controller is touched here; the menu refreshes after each flush.
        _apiClient.TrackingModeReported = (mode, startedAt) => _trackingMode.Report(mode, startedAt);

        _trayIcon = new TrayIconController(_config);
        _trayIcon.SettingsSaved += ApplyConfig;
        _trayIcon.TrackingModeSelected += mode => _ = SelectTrackingModeAsync(mode);

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

        // The server URL or API key may have changed, i.e. a different device.
        _trackingMode.Reset();
        UpdateTrackingModeMenu();

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
        _ = RefreshTrackingModeAsync();
    }

    // Awaited on the UI thread: the continuations resume there, so the menu
    // is only ever touched from it (the controller's own awaits don't
    // capture the context, but this method's do).
    private async Task RefreshTrackingModeAsync()
    {
        await _trackingMode.RefreshAsync(_config.ServerBaseUrl, _config.ApiKey);
        UpdateTrackingModeMenu();
    }

    private async Task SelectTrackingModeAsync(TrackingMode mode)
    {
        if (!_config.IsConfigured) return;
        _trayIcon.UpdateTrackingMode(_trackingMode.CurrentMode, isSwitching: true, error: null);
        await _trackingMode.SelectAsync(mode, _config.ServerBaseUrl, _config.ApiKey);
        UpdateTrackingModeMenu();
    }

    private void UpdateTrackingModeMenu() =>
        _trayIcon.UpdateTrackingMode(_trackingMode.CurrentMode, _trackingMode.IsSwitching, _trackingMode.LastError);

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
        UpdateTrackingModeMenu();
    }
}

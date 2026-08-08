using WorkTrackerTracker.Core;

namespace WorkTrackerTracker.App;

/// <summary>
/// Owns the tray icon and its context menu: a live status line, a pending
/// (not-yet-synced) event count, a settings dialog, and Exit. All actual
/// tracking logic lives in IdleMonitor / ActivityQueue; this is just the UI
/// shell around them — the Windows analogue of the Mac tracker's
/// StatusBarController.swift.
/// </summary>
internal sealed class TrayIconController : IDisposable
{
    private readonly NotifyIcon _notifyIcon;
    private readonly ToolStripMenuItem _statusItem;
    private readonly ToolStripMenuItem _pendingItem;
    private SettingsForm? _settingsForm;

    private TrackerConfig _currentConfig;

    public event Action<TrackerConfig>? SettingsSaved;

    public TrayIconController(TrackerConfig initialConfig)
    {
        _currentConfig = initialConfig;

        _statusItem = new ToolStripMenuItem { Enabled = false };
        _pendingItem = new ToolStripMenuItem { Enabled = false };

        var settingsItem = new ToolStripMenuItem("Settings…");
        settingsItem.Click += (_, _) => OpenSettings();

        var exitItem = new ToolStripMenuItem("Exit WorkTracker");
        exitItem.Click += (_, _) => Application.Exit();

        var menu = new ContextMenuStrip();
        menu.Items.Add(_statusItem);
        menu.Items.Add(_pendingItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(settingsItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exitItem);

        _notifyIcon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "WorkTracker",
            ContextMenuStrip = menu,
            Visible = true,
        };

        Update(isActive: false, pendingCount: 0);
    }

    public void Update(bool isActive, int pendingCount)
    {
        _statusItem.Text = !_currentConfig.IsConfigured
            ? "Not configured — open Settings…"
            : isActive ? "Status: Active" : "Status: Idle";
        _pendingItem.Text = pendingCount == 0 ? "All events synced" : $"{pendingCount} event(s) queued";
    }

    private void OpenSettings()
    {
        _settingsForm ??= new SettingsForm();
        _settingsForm.LoadConfig(_currentConfig);

        if (_settingsForm.ShowDialog() == DialogResult.OK)
        {
            _currentConfig = _settingsForm.Result;
            Update(isActive: false, pendingCount: 0);
            SettingsSaved?.Invoke(_currentConfig);
        }
    }

    public void Dispose()
    {
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        _settingsForm?.Dispose();
    }
}

using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using WorkTrackerTracker.Core;

namespace WorkTrackerTracker.App;

/// <summary>
/// Owns the tray icon and its context menu: a live status line, a pending
/// (not-yet-synced) event count, the work/leisure tracking-mode switch, a
/// settings dialog, and Exit. All actual tracking logic lives in IdleMonitor
/// / ActivityQueue / TrackingModeController; this is just the UI shell
/// around them — the Windows analogue of the Mac tracker's
/// StatusBarController.swift.
/// </summary>
internal sealed class TrayIconController : IDisposable
{
    private readonly NotifyIcon _notifyIcon;
    private readonly Icon _icon;
    private readonly ToolStripMenuItem _statusItem;
    private readonly ToolStripMenuItem _pendingItem;
    private readonly ToolStripMenuItem _lastSyncItem;
    private readonly ToolStripMenuItem _errorItem;
    private readonly ToolStripMenuItem _trackingModeItem;
    private readonly ToolStripMenuItem _trackingModeErrorItem;
    private readonly Dictionary<TrackingMode, ToolStripMenuItem> _trackingModeItems = new();
    private SettingsForm? _settingsForm;

    private TrackerConfig _currentConfig;

    public event Action<TrackerConfig>? SettingsSaved;
    public event Action<TrackingMode>? TrackingModeSelected;

    public TrayIconController(TrackerConfig initialConfig)
    {
        _currentConfig = initialConfig;

        _statusItem = new ToolStripMenuItem { Enabled = false };
        _pendingItem = new ToolStripMenuItem { Enabled = false };
        _lastSyncItem = new ToolStripMenuItem { Enabled = false };
        _errorItem = new ToolStripMenuItem { Enabled = false, Visible = false };

        _trackingModeItem = new ToolStripMenuItem("Tracking mode");
        foreach (var mode in TrackingModes.All)
        {
            var item = new ToolStripMenuItem(TrackingModes.MenuTitle(mode));
            item.Click += (_, _) => TrackingModeSelected?.Invoke(mode);
            _trackingModeItem.DropDownItems.Add(item);
            _trackingModeItems[mode] = item;
        }
        _trackingModeItem.DropDownItems.Add(new ToolStripSeparator());
        _trackingModeItem.DropDownItems.Add(new ToolStripMenuItem("Applies from now on") { Enabled = false });
        _trackingModeErrorItem = new ToolStripMenuItem { Enabled = false, Visible = false };

        var settingsItem = new ToolStripMenuItem("Settings…");
        settingsItem.Click += (_, _) => OpenSettings();

        var exitItem = new ToolStripMenuItem("Exit WorkTracker");
        exitItem.Click += (_, _) => Application.Exit();

        var menu = new ContextMenuStrip();
        menu.Items.Add(_statusItem);
        menu.Items.Add(_pendingItem);
        menu.Items.Add(_lastSyncItem);
        menu.Items.Add(_errorItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(_trackingModeItem);
        menu.Items.Add(_trackingModeErrorItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(settingsItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exitItem);

        _icon = CreateStopwatchIcon();
        _notifyIcon = new NotifyIcon
        {
            Icon = _icon,
            Text = "WorkTracker",
            ContextMenuStrip = menu,
            Visible = true,
        };

        Update(isActive: false, pendingCount: 0);
        UpdateTrackingMode(null, isSwitching: false, error: null);
    }

    /// <summary>
    /// Checks the current mode (none while unknown) and disables switching
    /// while unconfigured or while a switch is in flight. Call on the UI thread.
    /// </summary>
    public void UpdateTrackingMode(TrackingMode? mode, bool isSwitching, string? error)
    {
        var label = mode is { } known ? $"Tracking mode: {TrackingModes.MenuTitle(known)}" : "Tracking mode";
        _trackingModeItem.Text = isSwitching ? $"{label} (switching…)" : label;
        foreach (var (itemMode, item) in _trackingModeItems)
        {
            item.Checked = itemMode == mode;
            item.Enabled = _currentConfig.IsConfigured && !isSwitching;
        }
        _trackingModeErrorItem.Text = error is null ? string.Empty : $"⚠ Couldn't switch mode: {error}";
        _trackingModeErrorItem.Visible = error is not null;
    }

    // Drawn at runtime rather than shipped as an .ico resource, so the tray
    // glyph stays a single source file alongside the rest of the app shell.
    private static Icon CreateStopwatchIcon()
    {
        const int size = 32;
        using var bitmap = new Bitmap(size, size);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);

            using var outline = new Pen(Color.Black, 2f);

            // Crown (top button) and side knob.
            g.FillRectangle(Brushes.Black, 13, 1, 6, 4);
            g.FillRectangle(Brushes.Black, 10, 4, 12, 3);

            // Watch body.
            var bodyRect = new RectangleF(4, 6, 24, 24);
            g.FillEllipse(Brushes.White, bodyRect);
            g.DrawEllipse(outline, bodyRect);

            // Hands, pointing to 12 and 3.
            var center = new PointF(16, 18);
            g.DrawLine(outline, center, new PointF(16, 9));
            g.DrawLine(outline, center, new PointF(22, 18));
            g.FillEllipse(Brushes.Black, center.X - 1.5f, center.Y - 1.5f, 3, 3);
        }

        var hIcon = bitmap.GetHicon();
        try
        {
            using var temp = Icon.FromHandle(hIcon);
            return (Icon)temp.Clone();
        }
        finally
        {
            NativeMethods.DestroyIcon(hIcon);
        }
    }

    private static class NativeMethods
    {
        [DllImport("user32.dll")]
        public static extern bool DestroyIcon(IntPtr hIcon);
    }

    // Sticky across Update() calls that don't pass a fresh value (e.g. the
    // settings-saved path), so the line doesn't flicker back to "never".
    private DateTimeOffset? _lastKnownSyncAt;

    public void Update(bool isActive, int pendingCount, DateTimeOffset? lastSuccessfulSyncAt = null, string? lastError = null)
    {
        if (lastSuccessfulSyncAt is { } syncAt)
        {
            _lastKnownSyncAt = syncAt;
        }

        _statusItem.Text = !_currentConfig.IsConfigured
            ? "Not configured — open Settings…"
            : isActive ? "Status: Active" : "Status: Idle";
        _pendingItem.Text = pendingCount == 0 ? "All events synced" : $"{pendingCount} event(s) queued";
        _lastSyncItem.Text = _lastKnownSyncAt is { } last
            ? $"Last synced: {last.LocalDateTime.ToString("g", System.Globalization.CultureInfo.CurrentCulture)}"
            : "Last synced: never";
        _errorItem.Text = lastError is null ? string.Empty : $"⚠ Sync problem: {lastError}";
        _errorItem.Visible = lastError is not null;
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
        _icon.Dispose();
        _settingsForm?.Dispose();
    }
}

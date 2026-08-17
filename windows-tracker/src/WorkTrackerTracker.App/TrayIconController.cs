using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
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
    private readonly Icon _icon;
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

        _icon = CreateStopwatchIcon();
        _notifyIcon = new NotifyIcon
        {
            Icon = _icon,
            Text = "WorkTracker",
            ContextMenuStrip = menu,
            Visible = true,
        };

        Update(isActive: false, pendingCount: 0);
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
        _icon.Dispose();
        _settingsForm?.Dispose();
    }
}

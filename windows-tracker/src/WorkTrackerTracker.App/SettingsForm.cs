using WorkTrackerTracker.Core;

namespace WorkTrackerTracker.App;

/// <summary>
/// Settings dialog: server URL, API key, poll interval, and a "Start with
/// Windows" checkbox. Built entirely in code (no .resx/Designer split,
/// since there's no visual designer available when editing outside
/// Windows) — the Windows analogue of the Mac tracker's
/// SettingsWindowController.swift.
/// </summary>
internal sealed class SettingsForm : Form
{
    private readonly TextBox _serverUrlBox = new()
    {
        Multiline = true,
        ScrollBars = ScrollBars.Vertical,
        Width = 440,
        Height = 44,
        WordWrap = true,
    };

    private readonly TextBox _apiKeyBox = new()
    {
        Multiline = true,
        ScrollBars = ScrollBars.Vertical,
        Width = 440,
        Height = 60,
        WordWrap = true,
        Font = new Font(FontFamily.GenericMonospace, 9),
    };

    private readonly NumericUpDown _pollIntervalBox = new() { Minimum = 5, Maximum = 3600, Width = 100 };
    private readonly CheckBox _startWithWindowsBox = new() { Text = "Start WorkTracker with Windows", AutoSize = true };

    public TrackerConfig Result { get; private set; } = TrackerConfig.Empty;

    public SettingsForm()
    {
        Text = "WorkTracker Settings";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(16);

        var layout = new TableLayoutPanel
        {
            ColumnCount = 1,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
        };

        layout.Controls.Add(new Label
        {
            Text = "Server URL and API key come from the dashboard's Devices panel.",
            AutoSize = true,
            MaximumSize = new Size(440, 0),
            Margin = new Padding(0, 0, 0, 8),
        });
        layout.Controls.Add(Labeled("Server URL (e.g. https://your-project.vercel.app)", _serverUrlBox));
        layout.Controls.Add(Labeled("API Key", _apiKeyBox));
        layout.Controls.Add(Labeled("Poll interval (seconds)", _pollIntervalBox));
        layout.Controls.Add(_startWithWindowsBox);

        var saveButton = new Button { Text = "Save", DialogResult = DialogResult.OK, AutoSize = true };
        saveButton.Click += (_, _) => Save();
        var cancelButton = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, AutoSize = true };

        var buttonRow = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.RightToLeft,
            AutoSize = true,
            Margin = new Padding(0, 16, 0, 0),
        };
        buttonRow.Controls.Add(saveButton);
        buttonRow.Controls.Add(cancelButton);
        layout.Controls.Add(buttonRow);

        Controls.Add(layout);
        AcceptButton = saveButton;
        CancelButton = cancelButton;
    }

    private static Control Labeled(string text, Control control)
    {
        var panel = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown,
            AutoSize = true,
            WrapContents = false,
            Margin = new Padding(0, 0, 0, 12),
        };
        panel.Controls.Add(new Label
        {
            Text = text,
            AutoSize = true,
            ForeColor = SystemColors.GrayText,
            Font = new Font(SystemFonts.DefaultFont.FontFamily, 8),
        });
        panel.Controls.Add(control);
        return panel;
    }

    public void LoadConfig(TrackerConfig config)
    {
        _serverUrlBox.Text = config.ServerBaseUrl;
        _apiKeyBox.Text = config.ApiKey;
        _pollIntervalBox.Value = Math.Clamp(config.PollIntervalSeconds, (int)_pollIntervalBox.Minimum, (int)_pollIntervalBox.Maximum);
        _startWithWindowsBox.Checked = StartupRegistration.IsEnabled();
    }

    private void Save()
    {
        StartupRegistration.SetEnabled(_startWithWindowsBox.Checked);

        Result = new TrackerConfig(
            _serverUrlBox.Text.Trim(),
            _apiKeyBox.Text.Trim(),
            Math.Max(5, (int)_pollIntervalBox.Value));
    }
}

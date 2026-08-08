using Microsoft.Win32;

namespace WorkTrackerTracker.App;

/// <summary>
/// Registers/unregisters the app to start at Windows login via the classic
/// per-user HKCU "Run" registry key — no admin rights needed. The Windows
/// analogue of the Mac tracker's <c>SMAppService.mainApp</c> usage
/// (SettingsWindowController.swift).
/// </summary>
internal static class StartupRegistration
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "WorkTrackerTracker";

    public static bool IsEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
        return key?.GetValue(ValueName) is not null;
    }

    public static void SetEnabled(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true);

        if (enabled)
        {
            var exePath = Environment.ProcessPath ?? Application.ExecutablePath;
            key.SetValue(ValueName, $"\"{exePath}\"");
        }
        else
        {
            key.DeleteValue(ValueName, throwOnMissingValue: false);
        }
    }
}

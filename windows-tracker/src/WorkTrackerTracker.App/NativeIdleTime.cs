using System.Runtime.InteropServices;

namespace WorkTrackerTracker.App;

/// <summary>
/// Wraps the Win32 <c>GetLastInputInfo</c> API — timing only, never key
/// content or window titles, matching the "no keylogging" boundary from
/// docs/CONCEPT.md. The Windows analogue of the Mac tracker's
/// CGEventIdleTimeSource (IdleMonitor.swift).
/// </summary>
internal static class NativeIdleTime
{
    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    public static TimeSpan SecondsSinceLastInput()
    {
        var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
        if (!GetLastInputInfo(ref info))
        {
            return TimeSpan.Zero;
        }

        // Both are tick counts in milliseconds since system startup; this
        // wraps every ~49.7 days, same as GetTickCount itself, and is
        // accepted here (same tradeoff the original .NET implementation made).
        var idleMilliseconds = unchecked((uint)Environment.TickCount - info.dwTime);
        return TimeSpan.FromMilliseconds(idleMilliseconds);
    }
}

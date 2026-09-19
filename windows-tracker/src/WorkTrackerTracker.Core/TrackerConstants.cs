namespace WorkTrackerTracker.Core;

/// <summary>
/// Tracker-wide tuning constants, mirroring the Mac tracker's
/// TrackerConstants (Constants.swift).
/// </summary>
public static class TrackerConstants
{
    /// <summary>
    /// Flushes never happen more often than this, no matter how short the
    /// configured poll interval is — the dashboard's live view only polls
    /// every 15s, so flushing faster buys nothing.
    /// </summary>
    public static readonly TimeSpan MinFlushInterval = TimeSpan.FromSeconds(15);

    public const int MinPollIntervalSeconds = 5;
    public const int MaxPollIntervalSeconds = 3600;

    /// <summary>Per-request network timeout, so a hung connection can't stall syncing (or overlap flush ticks) for long.</summary>
    public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(30);
}

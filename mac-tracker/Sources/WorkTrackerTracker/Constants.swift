import Foundation

/// Small tracker-wide tuning constants, named here instead of left as
/// unexplained magic numbers where they're used (AppDelegate.swift,
/// SettingsWindowController.swift).
enum TrackerConstants {
    /// Flushes never happen more often than this, no matter how short the
    /// configured poll interval is — the dashboard's live view only polls
    /// `/api/stats/live` every 15s, so flushing faster than that buys nothing.
    static let minFlushIntervalSeconds: TimeInterval = 15

    /// The shortest poll interval a user can configure. Polling much faster
    /// than this doesn't meaningfully improve activity resolution, just add
    /// CPU/battery overhead.
    static let minPollIntervalSeconds: Int = 5

    /// The longest poll interval a user can configure (matches the Windows
    /// tracker's settings dialog).
    static let maxPollIntervalSeconds: Int = 3600

    /// Per-request network timeout. Shorter than a flush interval times a
    /// few, so a hung connection can't stall syncing for long.
    static let requestTimeoutSeconds: TimeInterval = 30
}

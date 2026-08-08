namespace WorkTrackerTracker.Core;

/// <summary>
/// Pure decision: given how long it's been since the last input and how
/// often the tracker polls, was the user active at some point during the
/// last poll interval? If so, "now" gets recorded as an activity event.
/// </summary>
/// <remarks>
/// This mirrors the client side of docs/SESSION_LOGIC_SPEC.md: the tracker
/// only ever reports "there was input around this time" — all idle-gap and
/// resume-confirmation logic lives server-side, computed from these raw
/// timestamps. Identical in spirit to the Mac tracker's
/// <c>shouldRecordActivity</c> in IdleMonitor.swift; kept as a standalone
/// pure function here too so it's testable without the real
/// GetLastInputInfo Win32 call.
/// </remarks>
public static class IdlePolicy
{
    public static bool ShouldRecordActivity(TimeSpan secondsSinceLastInput, TimeSpan pollInterval) =>
        secondsSinceLastInput < pollInterval;

    /// <summary>
    /// Widens the resume-confirmation window server-side logic expects the
    /// tracker's effective poll interval to be at least as generous as, so a
    /// slow poll interval doesn't get its own resumptions wrongly rejected.
    /// See docs/SESSION_LOGIC_SPEC.md's "Default value" section — kept here
    /// too since both trackers report their own poll interval to the server.
    /// </summary>
    public static readonly TimeSpan DefaultResumeConfirmationWindow = TimeSpan.FromSeconds(60);

    public static TimeSpan EffectiveResumeConfirmationWindow(TimeSpan pollInterval)
    {
        var doubled = pollInterval * 2;
        return doubled > DefaultResumeConfirmationWindow ? doubled : DefaultResumeConfirmationWindow;
    }
}

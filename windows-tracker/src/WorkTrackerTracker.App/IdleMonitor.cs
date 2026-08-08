using WorkTrackerTracker.Core;

namespace WorkTrackerTracker.App;

/// <summary>
/// Polls <see cref="NativeIdleTime"/> on a repeating WinForms timer (so
/// ticks land on the UI thread, matching NotifyIcon's threading
/// requirements) and invokes <c>onActive</c> once per poll tick where
/// <see cref="IdlePolicy.ShouldRecordActivity"/> says the user was active.
/// The Windows analogue of the Mac tracker's IdleMonitor.swift.
/// </summary>
internal sealed class IdleMonitor : IDisposable
{
    private readonly System.Windows.Forms.Timer _timer;
    private readonly TimeSpan _pollInterval;
    private readonly Action _onActive;

    public IdleMonitor(TimeSpan pollInterval, Action onActive)
    {
        _pollInterval = pollInterval;
        _onActive = onActive;
        _timer = new System.Windows.Forms.Timer { Interval = Math.Max(1, (int)pollInterval.TotalMilliseconds) };
        _timer.Tick += (_, _) => Tick();
    }

    public void Start() => _timer.Start();

    public void Stop() => _timer.Stop();

    private void Tick()
    {
        var idle = NativeIdleTime.SecondsSinceLastInput();
        if (IdlePolicy.ShouldRecordActivity(idle, _pollInterval))
        {
            _onActive();
        }
    }

    public void Dispose() => _timer.Dispose();
}

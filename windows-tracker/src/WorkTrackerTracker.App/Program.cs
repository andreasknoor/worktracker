namespace WorkTrackerTracker.App;

internal static class Program
{
    // Unique per app, not per machine/user, so a second launch anywhere
    // reliably detects the first — multiple instances would otherwise race
    // on the same queue.json (see ActivityQueue.Persist) and show one tray
    // icon each.
    private const string SingleInstanceMutexName = "WorkTrackerTracker-6F1A9E3B-3B1E-4C7A-9E2E-3F6E3A9B7B44";

    [STAThread]
    private static void Main()
    {
        using var singleInstanceMutex = new Mutex(initiallyOwned: true, SingleInstanceMutexName, out var createdNew);
        if (!createdNew)
        {
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new TrackerTrayApplicationContext());
    }
}

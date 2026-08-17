namespace WorkTrackerTracker.App;

/// <summary>
/// Mirrors the single global WorkTracker app version — package.json's
/// "version" and APP_VERSION in src/server/config.ts — bumped on every
/// change to the project, regardless of which part (server, dashboard, this
/// tracker, ...) actually changed. Kept as its own constant, not read from
/// package.json at runtime, for the same reason config.ts isn't: this
/// project builds independently of the Node workspace.
/// </summary>
internal static class AppVersion
{
    public const string Current = "1.10";
}

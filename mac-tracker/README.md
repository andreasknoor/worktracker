# WorkTracker Mac Tracker

A native macOS menu-bar app (Swift Package Manager, AppKit). Polls input
activity via `CGEventSource` (timing only — never key content or window
titles) and pushes timestamps to the WorkTracker server. See
`../docs/API_CONTRACT.md` for the wire protocol shared with the Windows
tracker, and `../docs/NOTES_FOR_MAC_BUILD.md` for why this only builds here.

## Build & test

```sh
swift build
swift test
```

`swift test` requires the full Xcode toolchain's `XCTest.framework`, which
the Command Line Tools alone don't include. If `xcode-select -p` points at
`/Library/Developer/CommandLineTools` rather than an `Xcode.app`, run tests
with:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test
```

## Run

Run it as a proper `.app` bundle, not the raw `swift run`/`.build/` binary —
a bundle-less process has no `CFBundleIdentifier`, and AppKit logs "missing
main bundle identifier" for it. In practice this means Control Center often
fails to render the menu-bar icon at all, even though the process is alive
and the status item registration technically succeeds.

```sh
./build-app.sh          # builds a release binary and packages dist/WorkTrackerTracker.app
open dist/WorkTrackerTracker.app
```

To stop it: `pkill -f WorkTrackerTracker` (there's no Dock icon to quit
from — `LSUIElement` in `Info.plist` hides it from the Dock and app
switcher — but the **Quit WorkTracker** menu-bar item works too).

`swift run` still works for quick local iteration on non-UI logic, but
don't rely on it to actually verify the menu-bar icon shows up — only the
bundled `.app` reliably does.

On first launch the menu-bar icon shows "Not configured". Open
**Settings…** and enter the server URL (e.g.
`https://your-project.vercel.app`) and the device API key issued once by
`POST /api/devices` in the dashboard's Devices panel.

The **Tracking mode** submenu switches this device between Auto (weekdays
work, weekends leisure), Work and Leisure, effective from that
moment. Time already tracked keeps its classification. A switch needs the
server to be reachable; it isn't queued. The checkmark also follows changes
made in the dashboard (the server reports the mode back with every event
batch).

Configuration and the pending-events queue are stored at
`~/Library/Application Support/WorkTracker/`.

## Structure

- `Config.swift` — `TrackerConfig` (server URL, API key, poll interval) and its JSON persistence.
- `IdleMonitor.swift` — the pure "was the user active during this poll window" decision (`shouldRecordActivity`), plus the real `CGEventSource`-backed timer loop.
- `ActivityQueue.swift` — persisted queue of not-yet-sent timestamps; survives quits and network blips.
- `APIClient.swift` — `POST /api/events`, batched, Bearer-authenticated; `GET`/`PUT /api/tracker/mode`.
- `TrackingMode.swift` — the tracking-mode values and `TrackingModeController` (startup read, menu switch, server-reported updates).
- `StatusBarController.swift` / `AppDelegate.swift` / `main.swift` — the menu-bar UI shell wiring the above together.

`Config`, `IdleMonitor`'s decision function, `ActivityQueue`, `TrackingModeController` and the API client's request/response handling are unit
tested (`Tests/WorkTrackerTrackerTests/`) against fakes — no real network or
system input state involved. The UI shell is intentionally thin and not
unit-tested, same split as the server side (`packages/core` vs.
`src/server`).

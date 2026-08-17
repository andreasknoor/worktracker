# WorkTracker Windows Tracker

A native Windows tray app (.NET / WinForms). Polls input activity via the
Win32 `GetLastInputInfo` API (timing only — never key content or window
titles) and pushes timestamps to the WorkTracker server. See
`../docs/API_CONTRACT.md` for the wire protocol shared with the Mac
tracker, and `../docs/NOTES_FOR_MAC_BUILD.md` for why this can only be
fully built and run on Windows.

## What was built where

This project was scaffolded on a Mac, using a locally-installed .NET SDK
(`dotnet-install.sh`, no Homebrew/admin rights needed) — see
`../docs/IMPLEMENTATION_NOTES.md` for why. The split:

- **`src/WorkTrackerTracker.Core/`** — platform-independent logic (config
  persistence, the activity queue, the HTTP client, the idle/poll decision
  function). No Windows APIs. **Built and unit-tested on the Mac** (21
  passing xUnit tests, `dotnet test`), the same way `packages/core` and the
  Mac tracker's testable pieces are.
- **`src/WorkTrackerTracker.App/`** — the Windows-only shell: `NotifyIcon`
  tray icon, the `GetLastInputInfo` P/Invoke wrapper, the settings dialog,
  and Registry-based "start with Windows" support. **Compiles cleanly on
  the Mac** (`<EnableWindowsTargeting>true</EnableWindowsTargeting>` in the
  `.csproj`, the same escape hatch `docs/NOTES_FOR_MAC_BUILD.md` describes)
  but was never run — that's only possible on a real Windows machine.
- **`test/WorkTrackerTracker.Core.Tests/`** — xUnit tests for `Core`.

## What still needs to happen on Windows

Nothing in `WorkTrackerTracker.App` has been run or interactively verified.
On the Windows machine:

```powershell
git pull
dotnet test test\WorkTrackerTracker.Core.Tests\WorkTrackerTracker.Core.Tests.csproj   # should still be 21/21
dotnet run --project src\WorkTrackerTracker.App\WorkTrackerTracker.App.csproj
```

Things to specifically check that couldn't be verified on the Mac:
- The tray icon actually appears and is visible (same class of issue the
  Mac tracker hit — see `docs/IMPLEMENTATION_NOTES.md`'s note on the
  invisible menu-bar icon; Windows' notification-area overflow behaves
  differently but is worth checking too).
- `GetLastInputInfo` returns sane values and idle detection feels right in
  practice (poll interval, resume behavior).
- The Settings dialog's layout (built entirely in code, no visual
  designer was available) — check that fields are readable and usable.
- "Start with Windows" actually adds/removes the expected
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value and that the
  app relaunches correctly at login.
- A real end-to-end run: does an activity event actually reach the server
  and show up on the dashboard?

## Run & test

```powershell
dotnet test test\WorkTrackerTracker.Core.Tests\WorkTrackerTracker.Core.Tests.csproj
dotnet build WorkTrackerTracker.slnx
dotnet run --project src\WorkTrackerTracker.App\WorkTrackerTracker.App.csproj
```

On first launch the tray icon shows "Not configured". Open **Settings…**
and enter the server URL (e.g. `https://your-project.vercel.app`) and the
device API key issued once by `POST /api/devices` in the dashboard's
Devices panel.

Configuration and the pending-events queue are stored at
`%AppData%\WorkTracker\`.

## Publishing for autostart

`dotnet run`/`dotnet build` produce a framework-dependent .exe that needs the
.NET Desktop Runtime installed system-wide — fine when launched from a dev
shell, but autostart (Registry `Run` key, no admin rights) fails with a
runtime-missing prompt if that runtime isn't already present. The
`.csproj` is configured for a self-contained publish instead, which bundles
the runtime into the output so the .exe runs standalone:

```powershell
dotnet publish src\WorkTrackerTracker.App\WorkTrackerTracker.App.csproj -c Release
```

Output lands in
`src\WorkTrackerTracker.App\bin\Release\net8.0-windows\win-x64\publish\`.
Point the "Start with Windows" Registry value (and any shortcut) at
`WorkTrackerTracker.App.exe` in that folder, not the `bin\Debug\...` build.

## Structure

- `TrackerConfig.cs` / `ConfigStore` — config (server URL, API key, poll interval) and its JSON persistence.
- `IdlePolicy.cs` — the pure "was the user active during this poll window" decision, plus the resume-confirmation-window widening rule from `docs/SESSION_LOGIC_SPEC.md`.
- `EventsApiClient.cs` — `POST /api/events`, batched, Bearer-authenticated.
- `ActivityQueue.cs` — persisted queue of not-yet-sent timestamps; survives quits and network blips.
- `NativeIdleTime.cs` / `IdleMonitor.cs` (App) — the real `GetLastInputInfo`-backed timer loop.
- `TrayIconController.cs` / `SettingsForm.cs` / `TrackerTrayApplicationContext.cs` (App) — the tray UI shell wiring the above together.

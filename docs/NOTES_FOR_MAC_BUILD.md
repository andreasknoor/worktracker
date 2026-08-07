# Build/Test Split Across Machines

## Can the Windows tracker be built on the Mac?

**No — build it on a Windows machine.** If the tracker is WinForms/.NET (`net8.0-windows`, `System.Windows.Forms`, `NotifyIcon`), it needs Windows desktop reference assemblies. You *can* set `<EnableWindowsTargeting>true</EnableWindowsTargeting>` to make such a project compile on macOS/Linux (this exists for Linux CI runners producing Windows artifacts), but you cannot run or test it there: `GetLastInputInfo` and the tray-icon APIs require a real Windows runtime. Writing tracker code on the Mac without ever running it is not worth the risk — Windows API edge cases (idle-time detection, tray icon behavior) need to be verified live.

If the tracker ends up being something other than WinForms (e.g. a Rust/Tauri app, or a minimal console app with a scheduled task instead of a tray icon), the same principle still applies to anything using `GetLastInputInfo` or other Win32 APIs: it needs a real Windows box to run and verify, even if it happens to cross-compile elsewhere.

## Recommended workflow (confirmed with the user)

1. **On the Mac:** build the server (Node.js/TS on Vercel) and the dashboard frontend. Push the repo to GitHub. Set up Vercel's GitHub integration so every push to the main branch auto-deploys — this removes the need to run `vercel deploy` from either machine manually.
2. **On this Windows machine:** `git clone`/`git pull` the same repo, but only build the `windows-tracker/` subfolder using the .NET SDK. This does not require Node.js or npm at all — treat it as a mono-repo with independent, differently-tooled subprojects (this is a normal and unremarkable setup, not a hack).
3. The Windows tracker needs two pieces of runtime config that only exist after the server's first deploy: the server's base URL (`https://<project>.vercel.app`) and a device API key issued via the server's device-registration endpoint (see `API_CONTRACT.md`). Until the server exists, the tracker can be built and unit-tested against a mocked HTTP client, but its end-to-end "does it actually post events" check has to wait for a live server URL.
4. Each side's `.gitignore` should stay scoped to its own toolchain: Node's `node_modules/`, `.vercel/`, `dist/` on one side; .NET's `bin/`, `obj/` on the other. No shared build artifacts are expected between the two.

## Mac tracker

Builds and runs natively on this machine — no cross-platform concerns. Needs its own idle-detection mechanism (e.g. `CGEventSourceSecondsSinceLastEventType` via a small Swift or Objective-C menu-bar app), since `GetLastInputInfo` is Windows-only and nothing from the Windows tracker's platform code is reusable. Only the wire protocol to the server (see `API_CONTRACT.md`) is shared between the two trackers.

# WorkTracker → Client/Server Handoff Package

This folder is a self-contained briefing package for starting a **brand-new** project: a Node.js/Vercel-based client/server rewrite of WorkTracker. It was prepared on the Windows machine that hosts the original all-local WorkTracker (.NET/WinForms/ASP.NET Core) project, for a fresh Claude Code session on a different machine (a Mac) with a different Claude account.

**Decision already made (do not re-litigate):** the old .NET implementation is being fully discarded. Nothing from its code is ported or referenced at build time. Only the *functional knowledge* captured in this package — business rules, API shape, dashboard UI/UX — is carried forward, re-implemented from scratch in Node.js/TypeScript for Vercel.

## Read these in order

1. **`CONCEPT.md`** — target architecture, why Vercel/Node.js was chosen over the original .NET stack, phased build plan, and the honest evaluation of trade-offs (including risks you should stay aware of during implementation).
2. **`NOTES_FOR_MAC_BUILD.md`** — what can and cannot be built/tested on this Mac. Read this before planning tracker work.
3. **`DATA_MODEL.md`** — entities, settings keys, defaults.
4. **`SESSION_LOGIC_SPEC.md`** — the exact business rules for turning raw activity timestamps into "work sessions". This is the single most important piece of domain logic in the whole project. Implement it exactly as specified, and port the test scenarios 1:1 before writing any UI on top of it.
5. **`API_CONTRACT.md`** — exact REST endpoint shapes (paths, query params, JSON field names/types) that the dashboard frontend expects. The dashboard frontend (see below) is being kept essentially unchanged, so the new server's API must match this contract, not the other way around.

## What to reuse as-is vs. rebuild

| Component | Action |
|---|---|
| `dashboard-frontend/` (HTML/CSS/JS) | **Reuse nearly verbatim.** Static, framework-free, talks to the API purely via `fetch()`. As long as the new server implements `API_CONTRACT.md` exactly, this should work with zero or near-zero changes. |
| Session/statistics business logic | **Reimplement from the spec**, not from old code. See `SESSION_LOGIC_SPEC.md`. Port the test scenarios from `reference-tests/` first. |
| Server (API, storage) | **New build.** Node.js/TypeScript on Vercel Functions, Postgres via Vercel Marketplace (e.g. Neon). See `CONCEPT.md`. |
| Windows tracker | **New build, but only buildable/testable on a Windows machine.** See `NOTES_FOR_MAC_BUILD.md`. |
| Mac tracker | **New build**, native to this machine. |
| Device/API-key management, dashboard auth | **New**, did not exist in the original single-device local app. See `CONCEPT.md`. |

## `reference-tests/`

Copies of the original C# xUnit test files. **These do not compile or run in the new project** — they're reference material only, to make sure the ported test scenarios (values, edge cases, expected outputs) aren't lost in translation. Treat every `[Fact]` in `SessionCalculatorTests.cs` and `StatisticsServiceTests.cs` as a required test case in whatever test framework the new project uses (e.g. Vitest).

# Session Calculation — Business Logic Specification

This is the single most important piece of domain logic in the project. It converts a flat list of raw activity timestamps into a list of "work sessions". **Implement exactly this behavior in the new codebase** (language-agnostic pseudocode below), and verify against every scenario in `reference-tests/SessionCalculatorTests.cs` before building anything on top of it.

## Inputs

- `timestamps: DateTime[]` — raw activity event times (any order; must be sorted first).
- `idleThreshold: Duration` — e.g. 30 minutes. A gap between consecutive timestamps larger than this ends a session.
- `resumeConfirmationWindow: Duration` — default **60 seconds**. See rule 3 below.

## Output

- `sessions: { start: DateTime, end: DateTime }[]` — a session's duration is `end - start`.

## Rules

1. **Sort first.** Timestamps may arrive out of order; always sort ascending before processing.

2. **Basic splitting rule.** Walk timestamps in order, tracking a running session's `start`/`end`. For each new timestamp `current`:
   - If `current - end <= idleThreshold`: the gap is a normal pause: extend the current session (`end = current`), keep going.
   - If `current - end > idleThreshold`: the gap is too large — **the entire gap counts as idle**, not just the portion above the threshold. The session closes at the *earlier* timestamp (the current `end`, unchanged). A new session tentatively starts at `current` — but see rule 3 before accepting it.
   - A gap **exactly equal to** the threshold does **not** split (only gaps *exceeding* it do).

3. **Resume-confirmation rule (easy to miss — has caused a real regression before).** An isolated event right after a large idle gap might just be an accidental mouse bump, not real resumption of work. So: after a gap exceeding `idleThreshold`, the event `current` only starts a real new session if there is a *following* event within `resumeConfirmationWindow` of `current`. If there is no such follow-up:
   - Treat `current` as noise — drop it entirely (it neither extends the prior session nor starts a new one).
   - Keep measuring the idle gap from the *same* prior session's `end` — i.e. don't let a dropped bump reset the gap-measurement anchor. If a real resumption happens later, the full elapsed idle time (including the invisible bump) counts as idle.
   - This can chain: multiple isolated bumps in a row are all dropped until a real, confirmed resumption occurs.

4. **Single timestamp** → one session with `start == end` (zero duration).

5. **Empty input** → empty session list.

## Concrete worked examples (from the canonical test suite)

- **30-min threshold, 45-min gap, confirmed:** activity at `T+0`, then `T+45` (gap 45 min > 30 min threshold), then `T+45:30` (confirms `T+45` within the 60s window). Result: two sessions — `[T+0, T+0]` and `[T+45, T+45:30]`. The idle gap between them is the full 45 minutes.
- **30-min threshold, exactly 30-min gap:** does **not** split — stays one session.
- **Unconfirmed bump, no follow-up at all:** `T+0`, `T+5`, `T+45` (isolated, nothing after it). Result: **one** session `[T+0, T+5]` — the `T+45` bump is invisible, doesn't extend or create anything.
- **Unconfirmed bump followed by a real, later resumption:** prior session ends at `T+5`. `T+45` is an accidental bump (40-min gap from `T+5`, unconfirmed — nothing within 60s follows it). Real work resumes at `T+90` (confirmed by `T+90:30`). Result: two sessions; the second starts at `T+90`, **not** at `T+45` — the bump must not backdate the new session's start. The measured idle gap is 85 minutes (`T+90 - T+5`), correctly including the invisible bump's time.
- **Custom wider confirmation window:** the same resume event confirmed only within a wider window (e.g. 5 minutes) than the 60s default should split into two sessions under the wider window but not under the default — confirming the window size is a real, respected parameter, not a hardcoded magic number.

## Derived aggregation logic (built on top of sessions — same care applies)

Once sessions exist, the following derived views are computed **on read, never persisted**:

- **Daily hours** — total worked duration per calendar day. A session spanning midnight must have its duration **split proportionally across each day it touches** (clip each day's slice to that day's `[00:00, 24:00)` window). This must use the correct time zone for day-boundary purposes (see the time-zone risk note in `CONCEPT.md`).
- **Daily segments (for the timeline chart)** — same midnight-splitting idea, but instead of a single duration-per-day number, produce a list of `{ startMinutes, endMinutes }` clock-time segments (minutes since local midnight, `0–1440` range) per day. A session spanning midnight contributes one clipped segment to each day it touches.
- **Period summary** — given a list of sessions and daily hours: `totalWorkedTime` (sum of daily hours), `activeDayCount` (days with `workedTime > 0`), `averageWorkedTimePerActiveDay` (`total / activeDayCount`, zero if no active days), `longestSession` (max single session duration, zero if no sessions).
- **"Live" today/current-session view** — when computing "how much have I worked today" for a live-updating dashboard: if the most recent session's `end` is still within `idleThreshold` of "now", treat that session as *still running* and extend its `end` to "now" before computing today's total and the current session's duration. Otherwise report `isActive: false` and a zero current-session duration (but today's total still reflects whatever was already worked).

## Range-query buffering (important, easy to get subtly wrong)

When loading events for any date range `[start, endExclusive)` to compute sessions within it: **fetch events starting `idleThreshold` before `start`**, not exactly at `start`. Without this buffer, a session that began just before the range boundary gets incorrectly truncated/restarted at the boundary instead of showing its true start time. This applies to every range-based query (week, month, summary, sessions list, live).

## Default value

`resumeConfirmationWindow` default is **60 seconds**. If the tracker's configured poll interval is larger than 30 seconds, widen the effective confirmation window to `max(60s, 2 × pollInterval)` — the window should comfortably fit at least two poll cycles, or genuine resumptions could be wrongly rejected as unconfirmed.

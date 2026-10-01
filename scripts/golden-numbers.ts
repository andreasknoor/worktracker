// CLI for the offline golden-numbers check (see scripts/goldenNumbers.ts).
//
// 1. Export (one read per table — the only database load of the check):
//      DATABASE_URL=... node --import tsx scripts/golden-numbers.ts export golden-export.json
// 2. Compare old vs. current classification, fully offline:
//      APP_TIME_ZONE=Europe/Berlin node --import tsx scripts/golden-numbers.ts check golden-export.json
//
// Exit code 1 on any mismatch. Export files contain personal activity data
// and are git-ignored (golden-export*.json).
import { readFileSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { compareGoldenNumbers, ORPHANED_EVENTS_KEY, type GoldenExport } from "./goldenNumbers.js";

async function exportDatabase(outFile: string): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const devices = await pool.query<{
      id: string;
      name: string;
      platform: "windows" | "mac";
      idle_threshold_minutes: number;
      poll_interval_seconds: number;
      tracking_mode: "auto" | "alwaysWork" | "alwaysLeisure";
      created_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id, name, platform, idle_threshold_minutes, poll_interval_seconds, tracking_mode, created_at, revoked_at
       FROM devices`,
    );
    const events = await pool.query<{ device_id: string | null; timestamp_utc: Date }>(
      `SELECT device_id, timestamp_utc FROM activity_events`,
    );
    const historyTable = await pool.query<{ exists: boolean }>(
      `SELECT to_regclass('device_tracking_mode_history') IS NOT NULL AS exists`,
    );
    const history = historyTable.rows[0]?.exists
      ? await pool.query<{ device_id: string; tracking_mode: "auto" | "alwaysWork" | "alwaysLeisure"; effective_from: Date }>(
          `SELECT device_id, tracking_mode, effective_from FROM device_tracking_mode_history`,
        )
      : null;

    const eventsByDevice: Record<string, number[]> = {};
    for (const row of events.rows) {
      const key = row.device_id ?? ORPHANED_EVENTS_KEY;
      (eventsByDevice[key] ??= []).push(row.timestamp_utc.getTime());
    }

    const data: GoldenExport = {
      exportedAt: new Date().toISOString(),
      devices: devices.rows.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        idleThresholdMinutes: d.idle_threshold_minutes,
        pollIntervalSeconds: d.poll_interval_seconds,
        trackingMode: d.tracking_mode,
        createdAt: d.created_at.getTime(),
        revokedAt: d.revoked_at?.getTime() ?? null,
      })),
      events: eventsByDevice,
      trackingModeHistory:
        history?.rows.map((h) => ({
          deviceId: h.device_id,
          trackingMode: h.tracking_mode,
          effectiveFrom: h.effective_from.getTime(),
        })) ?? null,
    };
    writeFileSync(outFile, JSON.stringify(data));
    console.log(
      `Exported ${data.devices.length} devices, ${events.rowCount} events, ` +
        `${data.trackingModeHistory?.length ?? "no"} history rows to ${outFile}`,
    );
  } finally {
    await pool.end();
  }
}

async function check(inFile: string): Promise<void> {
  const data = JSON.parse(readFileSync(inFile, "utf8")) as GoldenExport;
  const timeZone = process.env.APP_TIME_ZONE || "Europe/Berlin";
  const result = await compareGoldenNumbers(data, timeZone, Date.parse(data.exportedAt));

  console.log(
    `Compared ${result.daysCompared} day/workType buckets (${result.rangeStart} .. ${result.rangeEndExclusive}, ${timeZone})`,
  );
  if (result.mismatches.length === 0) {
    console.log("OK: identical to the v1.21 classification.");
    return;
  }
  for (const m of result.mismatches) {
    console.log(`MISMATCH ${m.workType} ${m.date}: expected ${m.expectedMs} ms, got ${m.actualMs} ms`);
  }
  process.exitCode = 1;
}

const [command, file] = process.argv.slice(2);
if (command === "export" && file) {
  await exportDatabase(file);
} else if (command === "check" && file) {
  await check(file);
} else {
  console.error("Usage: golden-numbers.ts export <file> | check <file>");
  process.exitCode = 2;
}

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { WhoopApiError, type WhoopClient } from "../whoop/client.js";
import type { Cycle, Recovery, Sleep, Workout } from "../whoop/types.js";
import { addDays, formatLocalDate, localDateOf, parseDateInput, startOfLocalDay } from "../util/dates.js";
import { kjToKcal, msToHm, msToHours, metersToKm, num, pct, round } from "../util/format.js";
import { guard, ok, READ_ONLY } from "./common.js";
import { sleepDurations } from "./sleep.js";

const DAY_MS = 86_400_000;

// ---------- helpers ----------

async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof WhoopApiError && err.status === 404) return null;
    throw err;
  }
}

/** Pick the cycle that represents the given local calendar day. */
export function pickCycleForDate(cycles: Cycle[], targetDate: string, dayStart: Date, dayEnd: Date): Cycle | null {
  const byLocalStart = cycles.find((c) => localDateOf(c.start, c.timezone_offset) === targetDate);
  if (byLocalStart) return byLocalStart;
  // Fallback: a cycle that overlaps the day (e.g. today's cycle started yesterday and is ongoing).
  return (
    cycles.find((c) => {
      const s = new Date(c.start).getTime();
      const e = c.end ? new Date(c.end).getTime() : Number.POSITIVE_INFINITY;
      return s <= dayEnd.getTime() && e >= dayStart.getTime();
    }) ?? null
  );
}

export async function findCycleForDate(client: WhoopClient, date: string | undefined, now: Date = new Date()): Promise<{ cycle: Cycle | null; targetDate: string }> {
  const dayStart = date ? parseDateInput(date, { now }) : startOfLocalDay(now);
  const targetDate = formatLocalDate(dayStart);
  const dayEnd = addDays(dayStart, 1);
  const page = await client.getPage<Cycle>("/v2/cycle", {
    start: addDays(dayStart, -2).toISOString(),
    end: dayEnd.toISOString(),
    limit: 10,
  });
  return { cycle: pickCycleForDate(page.records ?? [], targetDate, dayStart, dayEnd), targetDate };
}

function cycleSummary(c: Cycle) {
  return {
    id: c.id,
    start: c.start,
    end: c.end ?? null,
    ongoing: !c.end,
    score_state: c.score_state,
    strain: round(c.score?.strain, 1),
    kilocalories: kjToKcal(c.score?.kilojoule),
    average_heart_rate: c.score?.average_heart_rate ?? null,
    max_heart_rate: c.score?.max_heart_rate ?? null,
    step_count: c.step_count ?? null,
  };
}

function recoverySummary(r: Recovery | null) {
  if (!r) return null;
  return {
    score_state: r.score_state,
    recovery_score: r.score?.recovery_score ?? null,
    hrv_ms: round(r.score?.hrv_rmssd_milli, 1),
    resting_heart_rate: r.score?.resting_heart_rate ?? null,
    spo2_percentage: round(r.score?.spo2_percentage, 1),
    skin_temp_celsius: round(r.score?.skin_temp_celsius, 2),
    user_calibrating: r.score?.user_calibrating ?? null,
  };
}

function sleepSummary(s: Sleep | null) {
  if (!s) return null;
  const d = sleepDurations(s);
  return {
    id: s.id,
    start: s.start,
    end: s.end,
    nap: s.nap,
    score_state: s.score_state,
    performance_percentage: round(s.score?.sleep_performance_percentage, 0),
    efficiency_percentage: round(s.score?.sleep_efficiency_percentage, 0),
    consistency_percentage: round(s.score?.sleep_consistency_percentage, 0),
    respiratory_rate: round(s.score?.respiratory_rate, 1),
    hours_in_bed: msToHours(d?.in_bed_milli),
    hours_asleep: msToHours(d?.asleep_milli),
    hours_needed: msToHours(d?.needed_milli),
    hours_deep: msToHours(d?.deep_milli),
    hours_rem: msToHours(d?.rem_milli),
    hours_light: msToHours(d?.light_milli),
    hours_awake: msToHours(d?.awake_milli),
    disturbances: s.score?.stage_summary.disturbance_count ?? null,
    sleep_cycles: s.score?.stage_summary.sleep_cycle_count ?? null,
  };
}

function workoutSummary(w: Workout) {
  return {
    id: w.id,
    sport: w.sport_name ?? null,
    start: w.start,
    end: w.end,
    duration_minutes: Math.round((new Date(w.end).getTime() - new Date(w.start).getTime()) / 60_000),
    score_state: w.score_state,
    strain: round(w.score?.strain, 1),
    kilocalories: kjToKcal(w.score?.kilojoule),
    average_heart_rate: w.score?.average_heart_rate ?? null,
    max_heart_rate: w.score?.max_heart_rate ?? null,
    distance_km: metersToKm(w.score?.distance_meter),
  };
}

// ---------- trends ----------

export interface TrendRow {
  date: string;
  cycle_id: number;
  ongoing: boolean;
  strain: number | null;
  kilocalories: number | null;
  recovery_score: number | null;
  hrv_ms: number | null;
  resting_heart_rate: number | null;
  spo2_percentage: number | null;
  skin_temp_celsius: number | null;
  sleep_performance: number | null;
  sleep_hours: number | null;
  sleep_efficiency: number | null;
}

type Metric = Exclude<keyof TrendRow, "date" | "cycle_id" | "ongoing">;
const METRICS: Metric[] = [
  "strain",
  "kilocalories",
  "recovery_score",
  "hrv_ms",
  "resting_heart_rate",
  "spo2_percentage",
  "skin_temp_celsius",
  "sleep_performance",
  "sleep_hours",
  "sleep_efficiency",
];

export function buildTrendRows(cycles: Cycle[], recoveries: Recovery[], sleeps: Sleep[]): TrendRow[] {
  const recByCycle = new Map<number, Recovery>();
  for (const r of recoveries) recByCycle.set(r.cycle_id, r);
  const sleepByCycle = new Map<number, Sleep>();
  for (const s of sleeps) {
    if (s.nap || s.cycle_id == null) continue;
    const existing = sleepByCycle.get(s.cycle_id);
    const dur = (x: Sleep) => new Date(x.end).getTime() - new Date(x.start).getTime();
    if (!existing || dur(s) > dur(existing)) sleepByCycle.set(s.cycle_id, s);
  }
  const rows: TrendRow[] = cycles.map((c) => {
    const r = recByCycle.get(c.id);
    const s = sleepByCycle.get(c.id);
    const d = s ? sleepDurations(s) : null;
    return {
      date: localDateOf(c.start, c.timezone_offset),
      cycle_id: c.id,
      ongoing: !c.end,
      strain: round(c.score?.strain, 1),
      kilocalories: kjToKcal(c.score?.kilojoule),
      recovery_score: r?.score?.recovery_score ?? null,
      hrv_ms: round(r?.score?.hrv_rmssd_milli, 1),
      resting_heart_rate: r?.score?.resting_heart_rate ?? null,
      spo2_percentage: round(r?.score?.spo2_percentage, 1),
      skin_temp_celsius: round(r?.score?.skin_temp_celsius, 2),
      sleep_performance: round(s?.score?.sleep_performance_percentage, 0),
      sleep_hours: msToHours(d?.asleep_milli),
      sleep_efficiency: round(s?.score?.sleep_efficiency_percentage, 0),
    };
  });
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.cycle_id - b.cycle_id));
  return rows;
}

export interface MetricStats {
  avg: number | null;
  min: number | null;
  max: number | null;
  count: number;
}

export function stats(rows: TrendRow[], metric: Metric): MetricStats {
  const vals = rows.map((r) => r[metric]).filter((v): v is number => typeof v === "number");
  if (vals.length === 0) return { avg: null, min: null, max: null, count: 0 };
  const sum = vals.reduce((a, b) => a + b, 0);
  return { avg: round(sum / vals.length, 1), min: round(Math.min(...vals), 1), max: round(Math.max(...vals), 1), count: vals.length };
}

export function compareWindows(rows: TrendRow[]): Record<string, { last7: number | null; prior7: number | null; delta: number | null }> | null {
  if (rows.length < 14) return null;
  const last = rows.slice(-7);
  const prior = rows.slice(-14, -7);
  const out: Record<string, { last7: number | null; prior7: number | null; delta: number | null }> = {};
  for (const m of ["recovery_score", "hrv_ms", "resting_heart_rate", "strain", "sleep_performance", "sleep_hours"] as Metric[]) {
    const a = stats(last, m).avg;
    const b = stats(prior, m).avg;
    out[m] = { last7: a, prior7: b, delta: a != null && b != null ? round(a - b, 1) : null };
  }
  return out;
}

// ---------- registration ----------

export function registerAnalysisTools(server: McpServer, client: WhoopClient): void {
  server.registerTool(
    "whoop_get_daily_summary",
    {
      title: "Daily summary",
      description:
        "One-call overview of a day: the cycle (strain, calories), its recovery (score, HRV, RHR, SpO2, skin temp), the sleep you woke from (duration, stages, performance) and workouts in that cycle. Defaults to today. A WHOOP day (cycle) starts when you wake.",
      inputSchema: z.object({
        date: z.string().optional().describe('YYYY-MM-DD, "today" (default) or "yesterday". Picks the cycle that started on that local day.'),
      }),
      outputSchema: z.looseObject({
        date: z.string(),
        found: z.boolean(),
        cycle: z.looseObject({}).nullable(),
        recovery: z.looseObject({}).nullable(),
        sleep: z.looseObject({}).nullable(),
        workouts: z.array(z.looseObject({})),
        notes: z.array(z.string()),
      }),
      annotations: READ_ONLY,
    },
    async ({ date }) =>
      guard(async () => {
        const now = new Date();
        const { cycle, targetDate } = await findCycleForDate(client, date, now);
        if (!cycle) {
          return ok(`No WHOOP cycle found for ${targetDate}.`, {
            date: targetDate,
            found: false,
            cycle: null,
            recovery: null,
            sleep: null,
            workouts: [],
            notes: ["No cycle covers this date. Was the strap worn / synced?"],
          });
        }
        const notes: string[] = [];
        const [recovery, sleep, workouts] = await Promise.all([
          orNull(client.get<Recovery>(`/v2/cycle/${cycle.id}/recovery`)),
          orNull(client.get<Sleep>(`/v2/cycle/${cycle.id}/sleep`)),
          client.collect<Workout>("/v2/activity/workout", { start: cycle.start, end: cycle.end ?? now.toISOString(), limit: 25 }, 50),
        ]);
        if (!cycle.end) notes.push("This cycle is still in progress; strain and calories are partial.");
        if (cycle.score_state !== "SCORED") notes.push(`Cycle score state: ${cycle.score_state}.`);
        if (!recovery) notes.push("No recovery recorded for this cycle yet.");
        else if (recovery.score_state !== "SCORED") notes.push(`Recovery not scored yet (${recovery.score_state}).`);
        if (!sleep) notes.push("No sleep recorded for this cycle.");
        else if (sleep.score_state !== "SCORED") notes.push(`Sleep not scored yet (${sleep.score_state}).`);

        const out = {
          date: targetDate,
          found: true,
          cycle: cycleSummary(cycle),
          recovery: recoverySummary(recovery),
          sleep: sleepSummary(sleep),
          workouts: workouts.map(workoutSummary),
          notes,
        };
        const r = out.recovery;
        const s = out.sleep;
        const summary = [
          `WHOOP summary for ${targetDate} (cycle ${cycle.id}${cycle.end ? "" : ", ongoing"})`,
          `Recovery: ${r?.recovery_score != null ? `${Math.round(r.recovery_score)}%` : "n/a"} | HRV ${num(r?.hrv_ms)} ms | RHR ${r?.resting_heart_rate ?? "n/a"} bpm${
            r?.spo2_percentage != null ? ` | SpO2 ${num(r.spo2_percentage)}%` : ""
          }${r?.skin_temp_celsius != null ? ` | skin ${num(r.skin_temp_celsius)}°C` : ""}`,
          `Sleep: ${s ? `${s.hours_asleep ?? "n/a"}h asleep (${s.hours_in_bed ?? "n/a"}h in bed, need ${s.hours_needed ?? "n/a"}h) | performance ${pct(
            s.performance_percentage,
          )} | efficiency ${pct(s.efficiency_percentage)} | deep ${s.hours_deep ?? "n/a"}h, REM ${s.hours_rem ?? "n/a"}h` : "n/a"}`,
          `Strain: ${out.cycle.strain ?? "n/a"} | ${out.cycle.kilocalories ?? "n/a"} kcal | avg HR ${out.cycle.average_heart_rate ?? "n/a"} | max HR ${out.cycle.max_heart_rate ?? "n/a"}`,
          `Workouts: ${out.workouts.length === 0 ? "none" : out.workouts.map((w) => `${w.sport ?? "?"} ${msToHm(w.duration_minutes * 60_000)} strain ${w.strain ?? "n/a"}`).join("; ")}`,
          ...(notes.length ? [`Notes: ${notes.join(" ")}`] : []),
        ].join("\n");
        return ok(summary, out);
      }),
  );

  server.registerTool(
    "whoop_get_trends",
    {
      title: "Trends over N days",
      description:
        "Per-day table and aggregate stats (avg/min/max) over the last N days for recovery, HRV, resting HR, SpO2, skin temp, strain, calories, sleep hours/performance/efficiency. With 14+ days also compares the last 7 days to the prior 7.",
      inputSchema: z.object({
        days: z.number().int().min(1).max(90).default(7).describe("Window length ending now (1-90)."),
        includeRows: z.boolean().default(true).describe("Include the per-day rows (set false for just the stats)."),
      }),
      outputSchema: z.looseObject({
        days: z.number(),
        from: z.string(),
        to: z.string(),
        day_count: z.number(),
        stats: z.record(z.string(), z.looseObject({ avg: z.number().nullable(), min: z.number().nullable(), max: z.number().nullable(), count: z.number() })),
        comparison: z.record(z.string(), z.looseObject({})).nullable(),
        rows: z.array(z.looseObject({})).optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ days, includeRows }) =>
      guard(async () => {
        const now = new Date();
        const from = new Date(now.getTime() - days * DAY_MS);
        const range = { start: from.toISOString(), end: now.toISOString(), limit: 25 };
        const [cycles, recoveries, sleeps] = await Promise.all([
          client.collect<Cycle>("/v2/cycle", range, days + 5),
          client.collect<Recovery>("/v2/recovery", range, days + 5),
          client.collect<Sleep>("/v2/activity/sleep", range, days * 2 + 10),
        ]);
        const rows = buildTrendRows(cycles, recoveries, sleeps);
        const statsOut: Record<string, MetricStats> = {};
        for (const m of METRICS) statsOut[m] = stats(rows, m);
        const comparison = compareWindows(rows);
        const out = {
          days,
          from: from.toISOString(),
          to: now.toISOString(),
          day_count: rows.length,
          stats: statsOut,
          comparison,
          ...(includeRows ? { rows } : {}),
        };
        const line = (label: string, m: Metric, unit = "") =>
          `${label}: avg ${statsOut[m]!.avg ?? "n/a"}${unit} (min ${statsOut[m]!.min ?? "n/a"}, max ${statsOut[m]!.max ?? "n/a"}, n=${statsOut[m]!.count})`;
        const summary = [
          `WHOOP trends, last ${days} day(s): ${rows.length} cycle(s) from ${rows[0]?.date ?? "?"} to ${rows[rows.length - 1]?.date ?? "?"}`,
          line("Recovery", "recovery_score", "%"),
          line("HRV", "hrv_ms", " ms"),
          line("Resting HR", "resting_heart_rate", " bpm"),
          line("Strain", "strain"),
          line("Sleep", "sleep_hours", " h"),
          line("Sleep performance", "sleep_performance", "%"),
          ...(comparison
            ? [
                `Last 7 vs prior 7: ` +
                  Object.entries(comparison)
                    .map(([k, v]) => `${k} ${v.last7 ?? "n/a"} vs ${v.prior7 ?? "n/a"} (${v.delta != null && v.delta > 0 ? "+" : ""}${v.delta ?? "n/a"})`)
                    .join("; "),
              ]
            : []),
        ].join("\n");
        return ok(summary, out);
      }),
  );
}

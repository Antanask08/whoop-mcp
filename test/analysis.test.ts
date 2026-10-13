import { describe, expect, it } from "vitest";
import { buildTrendRows, compareWindows, pickCycleForDate, stats } from "../src/tools/analysis.js";
import { localDateOf, parseDateInput, parseOffsetMinutes, resolveRange } from "../src/util/dates.js";
import type { Cycle, Recovery, Sleep } from "../src/whoop/types.js";
import { fixture } from "./helpers.js";

const cycle = fixture<Cycle>("cycle");
const recovery = fixture<Recovery>("recovery");
const sleep = fixture<Sleep>("sleep");

function day(i: number): { c: Cycle; r: Recovery; s: Sleep } {
  const start = new Date(Date.parse("2026-09-20T01:00:00.000Z") + i * 86_400_000); // 06:30 IST
  const end = new Date(start.getTime() + 86_400_000);
  const c: Cycle = { ...cycle, id: 1000 + i, start: start.toISOString(), end: end.toISOString(), score: { ...cycle.score!, strain: 10 + i } };
  const r: Recovery = { ...recovery, cycle_id: c.id, score: { ...recovery.score!, recovery_score: 50 + i, hrv_rmssd_milli: 40 + i, resting_heart_rate: 60 - i } };
  const s: Sleep = { ...sleep, id: `s-${i}`, cycle_id: c.id, score: { ...sleep.score!, sleep_performance_percentage: 70 + i } };
  return { c, r, s };
}

describe("dates", () => {
  it("parses timezone offsets", () => {
    expect(parseOffsetMinutes("+05:30")).toBe(330);
    expect(parseOffsetMinutes("-04:00")).toBe(-240);
    expect(parseOffsetMinutes("Z")).toBe(0);
    expect(parseOffsetMinutes(undefined)).toBe(0);
  });

  it("computes the local date of a record in its own timezone", () => {
    // 22:00 UTC on the 11th is 03:30 on the 12th in +05:30
    expect(localDateOf("2026-10-11T22:00:00.000Z", "+05:30")).toBe("2026-10-12");
    expect(localDateOf("2026-10-11T22:00:00.000Z", "-04:00")).toBe("2026-10-11");
  });

  it("resolves days / date-only / relative inputs", () => {
    const now = new Date("2026-10-13T08:00:00.000Z");
    expect(resolveRange({ days: 7 }, now).start).toBe("2026-10-06T08:00:00.000Z");
    expect(resolveRange({ days: 7 }, now).end).toBeUndefined();
    const r = resolveRange({ start: "2026-10-01", end: "2026-10-02" }, now);
    expect(new Date(r.end!).getTime() - new Date(r.start!).getTime()).toBe(2 * 86_400_000);
    expect(parseDateInput("2026-10-05T10:00:00Z", { now }).toISOString()).toBe("2026-10-05T10:00:00.000Z");
    expect(() => resolveRange({ start: "2026-10-05", end: "2026-10-01" }, now)).toThrow(/before/);
    expect(() => parseDateInput("not a date")).toThrow(/Invalid date/);
  });
});

describe("pickCycleForDate", () => {
  it("prefers the cycle whose local start date matches", () => {
    const a = day(0).c; // starts 2026-09-20 local
    const b = day(1).c; // starts 2026-09-21 local
    const dayStart = new Date("2026-09-21T00:00:00+05:30");
    expect(pickCycleForDate([b, a], "2026-09-21", dayStart, new Date(dayStart.getTime() + 86_400_000))?.id).toBe(b.id);
  });

  it("falls back to an ongoing cycle that overlaps the day", () => {
    const ongoing: Cycle = { ...cycle, id: 7, start: "2026-10-12T01:00:00.000Z", end: null, timezone_offset: "+05:30" };
    const dayStart = new Date("2026-10-13T00:00:00+05:30");
    expect(pickCycleForDate([ongoing], "2026-10-13", dayStart, new Date(dayStart.getTime() + 86_400_000))?.id).toBe(7);
    expect(pickCycleForDate([], "2026-10-13", dayStart, new Date(dayStart.getTime() + 86_400_000))).toBeNull();
  });
});

describe("trends", () => {
  it("joins cycles, recoveries and main sleeps into ascending rows", () => {
    const days = [2, 0, 1].map(day); // deliberately unsorted
    const nap: Sleep = { ...sleep, id: "nap", cycle_id: 1000, nap: true, score: { ...sleep.score!, sleep_performance_percentage: 5 } };
    const rows = buildTrendRows(
      days.map((d) => d.c),
      days.map((d) => d.r),
      [...days.map((d) => d.s), nap],
    );
    expect(rows.map((r) => r.date)).toEqual(["2026-09-20", "2026-09-21", "2026-09-22"]);
    expect(rows[0]).toMatchObject({ cycle_id: 1000, strain: 10, recovery_score: 50, hrv_ms: 40, resting_heart_rate: 60, sleep_performance: 70, sleep_hours: 6.75 });
    expect(rows[2]!.recovery_score).toBe(52);
  });

  it("computes stats ignoring missing values", () => {
    const d = [0, 1, 2].map(day);
    const rows = buildTrendRows(d.map((x) => x.c), [d[0]!.r, d[2]!.r], d.map((x) => x.s));
    expect(stats(rows, "recovery_score")).toEqual({ avg: 51, min: 50, max: 52, count: 2 });
    expect(stats(rows, "strain")).toEqual({ avg: 11, min: 10, max: 12, count: 3 });
    expect(stats([], "strain")).toEqual({ avg: null, min: null, max: null, count: 0 });
  });

  it("compares last 7 vs prior 7 only with 14+ rows", () => {
    const d14 = Array.from({ length: 14 }, (_, i) => day(i));
    const rows = buildTrendRows(d14.map((x) => x.c), d14.map((x) => x.r), d14.map((x) => x.s));
    const cmp = compareWindows(rows)!;
    expect(cmp.recovery_score).toEqual({ last7: 60, prior7: 53, delta: 7 });
    expect(cmp.resting_heart_rate!.delta).toBe(-7);
    expect(compareWindows(rows.slice(0, 13))).toBeNull();
  });
});

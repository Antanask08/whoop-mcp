import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";
import type { Cycle, Recovery, Sleep, Workout } from "../src/whoop/types.js";
import { fixture, freshTokens, jsonResponse, makeClient, NOW, type Route } from "./helpers.js";

const cycle = fixture<Cycle>("cycle");
const recovery = fixture<Recovery>("recovery");
const sleep = fixture<Sleep>("sleep");
const workout = fixture<Workout>("workout");

const routes: Record<string, Route> = {
  "/developer/v2/user/profile/basic": () => jsonResponse({ user_id: 10129, email: "me@example.com", first_name: "Shubham", last_name: "G" }),
  "/developer/v2/user/measurement/body": () => jsonResponse({ height_meter: 1.75, weight_kilogram: 70, max_heart_rate: 192 }),
  "/developer/v2/cycle": (url) => {
    if (url.searchParams.get("nextToken") === "more") return jsonResponse({ records: [{ ...cycle, id: 93844 }], next_token: null });
    return jsonResponse({ records: [cycle], next_token: "more" });
  },
  "/developer/v2/cycle/93845": () => jsonResponse(cycle),
  "/developer/v2/cycle/93845/sleep": () => jsonResponse(sleep),
  "/developer/v2/cycle/93845/recovery": () => jsonResponse(recovery),
  "/developer/v2/cycle/404": () => jsonResponse({ message: "nope" }, 404),
  "/developer/v2/recovery": () => jsonResponse({ records: [recovery], next_token: null }),
  "/developer/v2/activity/sleep": () => jsonResponse({ records: [sleep, { ...sleep, id: "nap-1", nap: true }], next_token: null }),
  [`/developer/v2/activity/sleep/${sleep.id}`]: () => jsonResponse(sleep),
  "/developer/v2/activity/workout": () => jsonResponse({ records: [workout, { ...workout, id: "w2", sport_name: "weightlifting" }], next_token: null }),
  [`/developer/v2/activity/workout/${workout.id}`]: () => jsonResponse(workout),
};

type CallResult = { content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

let mcp: Client;
let calls: { url: URL; init: RequestInit }[];
let cleanup: () => Promise<void>;

async function connect(tokens = freshTokens()) {
  const made = makeClient(routes, tokens, () => NOW);
  calls = made.calls;
  const server = createServer(made.client);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: "test", version: "0" });
  await server.connect(serverSide);
  await mcp.connect(clientSide);
  cleanup = async () => {
    await mcp.close();
    await server.close();
  };
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  return (await mcp.callTool({ name, arguments: args })) as CallResult;
}

describe("tools over MCP", () => {
  beforeEach(() => connect());
  afterEach(() => cleanup());

  it("lists 14 read-only tools with input and output schemas", async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "whoop_auth_status",
        "whoop_get_body_measurements",
        "whoop_get_cycle",
        "whoop_get_cycle_recovery",
        "whoop_get_cycle_sleep",
        "whoop_get_daily_summary",
        "whoop_get_profile",
        "whoop_get_sleep",
        "whoop_get_trends",
        "whoop_get_workout",
        "whoop_list_cycles",
        "whoop_list_recoveries",
        "whoop_list_sleeps",
        "whoop_list_workouts",
      ].sort(),
    );
    for (const t of tools) {
      expect(t.inputSchema, t.name).toBeDefined();
      expect(t.outputSchema, t.name).toBeDefined();
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
    }
  });

  it("whoop_get_profile returns structured content", async () => {
    const r = await call("whoop_get_profile");
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ user_id: 10129, email: "me@example.com" });
    expect(r.content[0]!.text).toContain("Shubham G");
  });

  it("whoop_get_body_measurements adds BMI", async () => {
    const r = await call("whoop_get_body_measurements");
    expect(r.structuredContent).toMatchObject({ weight_kilogram: 70, bmi: 22.9 });
  });

  it("whoop_list_cycles passes date params and returns next_token", async () => {
    const r = await call("whoop_list_cycles", { days: 7, limit: 5 });
    const req = calls.find((c) => c.url.pathname === "/developer/v2/cycle")!;
    expect(req.url.searchParams.get("limit")).toBe("5");
    // `days` is relative to wall-clock now (not the client's injected clock)
    const start = Date.parse(req.url.searchParams.get("start")!);
    expect(Math.abs(Date.now() - 7 * 86_400_000 - start)).toBeLessThan(60_000);
    expect(req.url.searchParams.get("end")).toBeNull();
    expect(r.structuredContent).toMatchObject({ count: 1, next_token: "more" });
    expect(r.content[0]!.text).toContain("strain 12.4");
  });

  it("whoop_list_cycles with all=true auto-paginates", async () => {
    const r = await call("whoop_list_cycles", { all: true, maxRecords: 10 });
    expect(r.structuredContent).toMatchObject({ count: 2, truncated: false });
    expect((r.structuredContent!.records as Cycle[]).map((c) => c.id)).toEqual([93845, 93844]);
  });

  it("rejects invalid input before calling WHOOP", async () => {
    const r = await call("whoop_list_cycles", { limit: 100 });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("whoop_get_cycle / sleep / recovery by cycle id", async () => {
    expect((await call("whoop_get_cycle", { cycleId: 93845 })).structuredContent).toMatchObject({ id: 93845 });
    expect((await call("whoop_get_cycle_sleep", { cycleId: 93845 })).structuredContent).toMatchObject({ id: sleep.id });
    const rec = await call("whoop_get_cycle_recovery", { cycleId: 93845 });
    expect(rec.structuredContent).toMatchObject({ cycle_id: 93845 });
    expect(rec.content[0]!.text).toContain("72%");
  });

  it("surfaces 404 as an isError result", async () => {
    const r = await call("whoop_get_cycle", { cycleId: 404 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/404/);
  });

  it("whoop_list_sleeps can drop naps client-side", async () => {
    const withNaps = await call("whoop_list_sleeps", {});
    expect(withNaps.structuredContent!.count).toBe(2);
    const noNaps = await call("whoop_list_sleeps", { includeNaps: false });
    expect(noNaps.structuredContent!.count).toBe(1);
    expect(noNaps.content[0]!.text).toContain("asleep 6h 45m");
  });

  it("whoop_get_sleep and whoop_get_workout by uuid", async () => {
    expect((await call("whoop_get_sleep", { sleepId: sleep.id })).structuredContent).toMatchObject({ id: sleep.id, nap: false });
    const w = await call("whoop_get_workout", { workoutId: workout.id });
    expect(w.structuredContent).toMatchObject({ sport_name: "running" });
    expect(w.content[0]!.text).toContain("7.85 km");
  });

  it("whoop_list_workouts filters by sport name", async () => {
    const r = await call("whoop_list_workouts", { sportName: "WEIGHT" });
    expect(r.structuredContent!.count).toBe(1);
    expect((r.structuredContent!.records as Workout[])[0]!.id).toBe("w2");
  });

  it("whoop_list_recoveries", async () => {
    const r = await call("whoop_list_recoveries", { start: "2026-10-01", end: "2026-10-13" });
    expect(r.structuredContent!.count).toBe(1);
    const req = calls.find((c) => c.url.pathname === "/developer/v2/recovery")!;
    expect(req.url.searchParams.get("start")).toBeTruthy();
    expect(req.url.searchParams.get("end")).toBeTruthy();
  });

  it("whoop_get_daily_summary composes cycle, recovery, sleep and workouts", async () => {
    const r = await call("whoop_get_daily_summary", { date: "2026-10-12" });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent!;
    expect(sc.found).toBe(true);
    expect(sc.cycle).toMatchObject({ id: 93845, strain: 12.4, kilocalories: 2342 });
    expect(sc.recovery).toMatchObject({ recovery_score: 72, hrv_ms: 58.3, resting_heart_rate: 52 });
    expect(sc.sleep).toMatchObject({ hours_asleep: 6.75, hours_in_bed: 7.25, performance_percentage: 84, hours_needed: 8 });
    expect((sc.workouts as unknown[]).length).toBe(2);
    expect(r.content[0]!.text).toContain("Recovery: 72%");
  });

  it("whoop_get_trends aggregates the window", async () => {
    const r = await call("whoop_get_trends", { days: 7 });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent!;
    expect(sc.day_count).toBe(2);
    expect((sc.stats as Record<string, { avg: number }>).recovery_score.avg).toBe(72);
    expect(sc.comparison).toBeNull();
    expect(Array.isArray(sc.rows)).toBe(true);
  });

  it("whoop_auth_status reports connection", async () => {
    const r = await call("whoop_auth_status");
    expect(r.structuredContent).toMatchObject({ authenticated: true, clientConfigured: true, expiresInSeconds: 3600 });
  });
});

describe("tools without tokens", () => {
  beforeEach(() => connect(null as never));
  afterEach(() => cleanup());

  it("data tools return an actionable isError, auth status says not connected", async () => {
    const r = await call("whoop_get_profile");
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("npm run auth");
    const s = await call("whoop_auth_status");
    expect(s.isError).toBeFalsy();
    expect(s.structuredContent).toMatchObject({ authenticated: false });
  });
});

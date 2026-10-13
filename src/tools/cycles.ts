import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { WhoopClient } from "../whoop/client.js";
import type { Cycle, Recovery, Sleep } from "../whoop/types.js";
import { kjToKcal, num } from "../util/format.js";
import { cycleSchema, guard, listSchema, ok, pageShape, rangeShape, READ_ONLY, recoverySchema, sleepSchema } from "./common.js";
import { listRecords } from "./list.js";

export function describeCycle(c: Cycle): string {
  const when = `${c.start.slice(0, 16)} → ${c.end ? c.end.slice(0, 16) : "ongoing"}`;
  if (c.score_state !== "SCORED" || !c.score) return `Cycle ${c.id} (${when}): ${c.score_state}`;
  return `Cycle ${c.id} (${when}): strain ${num(c.score.strain)}, ${kjToKcal(c.score.kilojoule)} kcal, avg HR ${c.score.average_heart_rate}, max HR ${c.score.max_heart_rate}`;
}

export function registerCycleTools(server: McpServer, client: WhoopClient): void {
  server.registerTool(
    "whoop_list_cycles",
    {
      title: "List physiological cycles",
      description:
        "List WHOOP cycles (a cycle is one physiological day, starting when you wake). Each has strain, calories (kilojoule), avg/max heart rate. Newest first. Use `days`, or `start`/`end`, to pick a window.",
      inputSchema: z.object({ ...rangeShape, ...pageShape }),
      outputSchema: listSchema(cycleSchema),
      annotations: READ_ONLY,
    },
    async (args) =>
      guard(async () => {
        const result = await listRecords<Cycle>(client, "/v2/cycle", args);
        const lines = result.records.slice(0, 10).map(describeCycle).join("\n");
        return ok(`${result.count} cycle(s)${result.next_token ? " (more available)" : ""}\n${lines}`, { ...result });
      }),
  );

  server.registerTool(
    "whoop_get_cycle",
    {
      title: "Get cycle by ID",
      description: "Fetch one cycle by its numeric ID.",
      inputSchema: z.object({ cycleId: z.number().int().describe("Numeric cycle ID.") }),
      outputSchema: cycleSchema,
      annotations: READ_ONLY,
    },
    async ({ cycleId }) =>
      guard(async () => {
        const c = await client.get<Cycle>(`/v2/cycle/${cycleId}`);
        return ok(describeCycle(c), { ...c });
      }),
  );

  server.registerTool(
    "whoop_get_cycle_sleep",
    {
      title: "Get the sleep for a cycle",
      description: "The main sleep that began the given cycle (the sleep you woke from).",
      inputSchema: z.object({ cycleId: z.number().int() }),
      outputSchema: sleepSchema,
      annotations: READ_ONLY,
    },
    async ({ cycleId }) =>
      guard(async () => {
        const s = await client.get<Sleep>(`/v2/cycle/${cycleId}/sleep`);
        return ok(`Sleep ${s.id} for cycle ${cycleId}: ${s.score_state}`, { ...s });
      }),
  );

  server.registerTool(
    "whoop_get_cycle_recovery",
    {
      title: "Get the recovery for a cycle",
      description: "Recovery score, HRV, resting heart rate, SpO2 and skin temperature for the given cycle.",
      inputSchema: z.object({ cycleId: z.number().int() }),
      outputSchema: recoverySchema,
      annotations: READ_ONLY,
    },
    async ({ cycleId }) =>
      guard(async () => {
        const r = await client.get<Recovery>(`/v2/cycle/${cycleId}/recovery`);
        return ok(describeRecovery(r), { ...r });
      }),
  );
}

export function describeRecovery(r: Recovery): string {
  if (r.score_state !== "SCORED" || !r.score) return `Recovery for cycle ${r.cycle_id}: ${r.score_state}`;
  const s = r.score;
  return `Recovery for cycle ${r.cycle_id}: ${Math.round(s.recovery_score)}% (HRV ${num(s.hrv_rmssd_milli)} ms, RHR ${s.resting_heart_rate} bpm${
    s.spo2_percentage != null ? `, SpO2 ${num(s.spo2_percentage)}%` : ""
  }${s.skin_temp_celsius != null ? `, skin ${num(s.skin_temp_celsius)}°C` : ""}${s.user_calibrating ? ", calibrating" : ""})`;
}

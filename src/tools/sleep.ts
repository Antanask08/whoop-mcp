import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { WhoopClient } from "../whoop/client.js";
import type { Sleep } from "../whoop/types.js";
import { msToHm, num, pct } from "../util/format.js";
import { guard, listSchema, ok, pageShape, rangeShape, READ_ONLY, sleepSchema } from "./common.js";
import { listRecords } from "./list.js";

export function sleepDurations(s: Sleep) {
  const st = s.score?.stage_summary;
  if (!st) return null;
  const asleep = st.total_light_sleep_time_milli + st.total_slow_wave_sleep_time_milli + st.total_rem_sleep_time_milli;
  return {
    in_bed_milli: st.total_in_bed_time_milli,
    asleep_milli: asleep,
    awake_milli: st.total_awake_time_milli,
    light_milli: st.total_light_sleep_time_milli,
    deep_milli: st.total_slow_wave_sleep_time_milli,
    rem_milli: st.total_rem_sleep_time_milli,
    needed_milli: s.score?.sleep_needed
      ? s.score.sleep_needed.baseline_milli +
        s.score.sleep_needed.need_from_sleep_debt_milli +
        s.score.sleep_needed.need_from_recent_strain_milli +
        s.score.sleep_needed.need_from_recent_nap_milli
      : null,
  };
}

export function describeSleep(s: Sleep): string {
  const when = `${s.start.slice(0, 16)} → ${s.end.slice(0, 16)}`;
  const kind = s.nap ? "Nap" : "Sleep";
  if (s.score_state !== "SCORED" || !s.score) return `${kind} ${s.id} (${when}): ${s.score_state}`;
  const d = sleepDurations(s)!;
  return `${kind} ${s.id} (${when}): asleep ${msToHm(d.asleep_milli)} of ${msToHm(d.in_bed_milli)} in bed, performance ${pct(
    s.score.sleep_performance_percentage,
  )}, efficiency ${pct(s.score.sleep_efficiency_percentage)}, consistency ${pct(s.score.sleep_consistency_percentage)}, deep ${msToHm(
    d.deep_milli,
  )}, REM ${msToHm(d.rem_milli)}, ${s.score.stage_summary.disturbance_count} disturbances, RR ${num(s.score.respiratory_rate)}`;
}

export function registerSleepTools(server: McpServer, client: WhoopClient): void {
  server.registerTool(
    "whoop_list_sleeps",
    {
      title: "List sleeps",
      description:
        "List sleep sessions (and naps) with stage breakdown (light/deep/REM/awake in ms), sleep need, performance/efficiency/consistency percentages and respiratory rate. Newest first.",
      inputSchema: z.object({
        ...rangeShape,
        ...pageShape,
        includeNaps: z.boolean().default(true).describe("Set false to drop naps (filtered client-side)."),
      }),
      outputSchema: listSchema(sleepSchema),
      annotations: READ_ONLY,
    },
    async (args) =>
      guard(async () => {
        const result = await listRecords<Sleep>(client, "/v2/activity/sleep", args, args.includeNaps ? undefined : (s) => !s.nap);
        const lines = result.records.slice(0, 10).map(describeSleep).join("\n");
        return ok(`${result.count} sleep record(s)${result.next_token ? " (more available)" : ""}\n${lines}`, { ...result });
      }),
  );

  server.registerTool(
    "whoop_get_sleep",
    {
      title: "Get sleep by ID",
      description: "Fetch one sleep session by its UUID.",
      inputSchema: z.object({ sleepId: z.string().describe("Sleep UUID (v2).") }),
      outputSchema: sleepSchema,
      annotations: READ_ONLY,
    },
    async ({ sleepId }) =>
      guard(async () => {
        const s = await client.get<Sleep>(`/v2/activity/sleep/${encodeURIComponent(sleepId)}`);
        return ok(describeSleep(s), { ...s });
      }),
  );
}

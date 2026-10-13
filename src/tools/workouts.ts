import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { WhoopClient } from "../whoop/client.js";
import type { Workout } from "../whoop/types.js";
import { kjToKcal, metersToKm, msToHm, num } from "../util/format.js";
import { guard, listSchema, ok, pageShape, rangeShape, READ_ONLY, workoutSchema } from "./common.js";
import { listRecords } from "./list.js";

export function describeWorkout(w: Workout): string {
  const dur = msToHm(new Date(w.end).getTime() - new Date(w.start).getTime());
  const head = `${w.sport_name ?? `sport ${w.sport_id ?? "?"}`} on ${w.start.slice(0, 16)} (${dur})`;
  if (w.score_state !== "SCORED") return `${head}: ${w.score_state}`;
  if (!w.score) return `${head}: scored, no strain/HR metrics (WHOOP omits them for activities like meditation)`;
  const s = w.score;
  const dist = s.distance_meter != null ? `, ${metersToKm(s.distance_meter)} km` : "";
  return `${head}: strain ${num(s.strain)}, ${kjToKcal(s.kilojoule)} kcal, avg HR ${s.average_heart_rate}, max HR ${s.max_heart_rate}${dist}`;
}

export function registerWorkoutTools(server: McpServer, client: WhoopClient): void {
  server.registerTool(
    "whoop_list_workouts",
    {
      title: "List workouts",
      description:
        "List workouts with sport, strain, calories, heart-rate zones, distance and altitude. Newest first. Optionally filter by sport name (case-insensitive substring, client-side).",
      inputSchema: z.object({
        ...rangeShape,
        ...pageShape,
        sportName: z.string().optional().describe('e.g. "running", "weightlifting". Case-insensitive substring match.'),
      }),
      outputSchema: listSchema(workoutSchema),
      annotations: READ_ONLY,
    },
    async (args) =>
      guard(async () => {
        const needle = args.sportName?.toLowerCase();
        const result = await listRecords<Workout>(
          client,
          "/v2/activity/workout",
          args,
          needle ? (w) => (w.sport_name ?? "").toLowerCase().includes(needle) : undefined,
        );
        const lines = result.records.slice(0, 10).map(describeWorkout).join("\n");
        return ok(`${result.count} workout(s)${result.next_token ? " (more available)" : ""}\n${lines}`, { ...result });
      }),
  );

  server.registerTool(
    "whoop_get_workout",
    {
      title: "Get workout by ID",
      description: "Fetch one workout by its UUID, including heart-rate zone durations.",
      inputSchema: z.object({ workoutId: z.string().describe("Workout UUID (v2).") }),
      outputSchema: workoutSchema,
      annotations: READ_ONLY,
    },
    async ({ workoutId }) =>
      guard(async () => {
        const w = await client.get<Workout>(`/v2/activity/workout/${encodeURIComponent(workoutId)}`);
        return ok(describeWorkout(w), { ...w });
      }),
  );
}

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { WhoopClient } from "../whoop/client.js";
import type { BodyMeasurement, UserProfile } from "../whoop/types.js";
import { round } from "../util/format.js";
import { guard, ok, READ_ONLY } from "./common.js";

export function registerProfileTools(server: McpServer, client: WhoopClient): void {
  server.registerTool(
    "whoop_get_profile",
    {
      title: "Get WHOOP profile",
      description: "Basic profile of the connected WHOOP user: user_id, email, first and last name.",
      inputSchema: z.object({}),
      outputSchema: z.looseObject({ user_id: z.number(), email: z.string(), first_name: z.string(), last_name: z.string() }),
      annotations: READ_ONLY,
    },
    async () =>
      guard(async () => {
        const p = await client.get<UserProfile>("/v2/user/profile/basic");
        return ok(`${p.first_name} ${p.last_name} (${p.email}), user_id ${p.user_id}`, { ...p });
      }),
  );

  server.registerTool(
    "whoop_get_body_measurements",
    {
      title: "Get body measurements",
      description: "Height (m), weight (kg) and WHOOP's estimated max heart rate for the user, plus derived BMI.",
      inputSchema: z.object({}),
      outputSchema: z.looseObject({
        height_meter: z.number(),
        weight_kilogram: z.number(),
        max_heart_rate: z.number(),
        bmi: z.number().nullable(),
      }),
      annotations: READ_ONLY,
    },
    async () =>
      guard(async () => {
        const b = await client.get<BodyMeasurement>("/v2/user/measurement/body");
        const bmi = b.height_meter > 0 ? round(b.weight_kilogram / (b.height_meter * b.height_meter), 1) : null;
        return ok(
          `Height ${round(b.height_meter, 2)} m, weight ${round(b.weight_kilogram, 1)} kg, max HR ${b.max_heart_rate} bpm, BMI ${bmi ?? "n/a"}`,
          { ...b, bmi },
        );
      }),
  );
}
